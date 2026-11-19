# ADR 027: Changelog retention and full resync

- **Status:** Proposed
- **Date:** 2026-11-19
- **Area:** Sync

## Summary

The server deletes changelog rows older than a retention period. The default is 30 days, and each app can change it. A client with no cursor, or with a cursor from before the oldest row kept, can't catch up from the changelog. The pull endpoint tells it so with HTTP 410. The client then downloads a snapshot of every record it owns from a separate full-sync endpoint, deletes local records the snapshot didn't include, and resumes normal pulls.

## Context

- **The changelog grows forever.** Every applied push adds a row, and nothing deletes them.
- **A first sync replays every change ever made.** A new device pulls the whole history page by page, including rows that were later updated or deleted. A snapshot of current state is much smaller.
- **Deleting old rows breaks clients that need them.** A client whose cursor is older than the deleted rows would silently miss those changes. The server must detect this and send the client somewhere else.

## Decision

### Retention

- **`sync-server-sql` exports `evictChangelog(db, { olderThanMs })`.** `olderThanMs` defaults to 30 days. The app calls it on its own schedule, such as a daily cron job. The library runs no background jobs.
- **Eviction deletes by id range.** Changelog ids are UUID v7, so they start with a timestamp. The function builds the smallest id for the cutoff time and deletes every row below it, in batches, using the primary-key index.
- **Eviction records a watermark.** A one-row table holds `evictedBefore`, the cutoff id of the latest eviction. The watermark only moves forward.
- **Eviction never touches the row-version table** from [ADR 026](ADR%20026%20-%20Stale%20Writes%20Are%20Rejected%20by%20Base%20Version.md).

### Detecting a stale cursor

`pull` answers `{ ok: false, reason: "resync-required" }` when either is true:

- The cursor is `null`.
- The cursor is lower than `evictedBefore`.

The HTTP handler maps that to status 410.

The check is safe because eviction only ever removes a prefix of ids. If the cursor is at or above the watermark, every later row still exists. If the cursor is below it, the client may have missed rows, so it must resync. Some clients resync when they didn't strictly need to, such as a client idle for longer than the retention period whose scope had no changes. That costs one snapshot download, which is acceptable.

A `null` cursor always resyncs, even before any eviction has run. A snapshot is cheaper than replaying the history.

### The full-sync endpoint

- **Route and adapter method.** `createSqlSync` returns a third handler, `fullSync(request)`. The adapter gains `fullSync(db, { scopeKey, clientStorageHash, pageToken?, limit? })`. It runs the same contract check as `pull` and `applyPush`.
- **Response.** One page is `{ snapshotCursor, records, nextPageToken }`. Each record is `{ model, keyPath, record }`, projected to the client contract and wire-encoded the same way as a pulled record. `nextPageToken` is `null` on the last page.
- **The snapshot cursor is read before any data.** On the first page, the server reads the scope's highest changelog id. If the scope has none, it uses `evictedBefore`, or the lowest possible id if nothing was ever evicted. The value goes into the page token, so every page reports the same cursor.
- **Pages don't share a transaction.** Rows change between pages. That is safe:
  - A change after the snapshot cursor reaches the client through a normal pull later.
  - Snapshot records are current state, so applying a record twice changes nothing.
  - A row deleted mid-snapshot is removed by the sweep, and its later delete entry is a no-op.
- **Order.** Models are listed parents first, following the ownership graph. Rows within a model are paged by primary key. The page token holds the snapshot cursor, the model position and the last key. It is opaque to the client and validated on every request. A forged token can only affect the caller's own scope.
- **Listing what a scope owns needs a new query.** `buildPullQueries` checks one known key at a time, and the SQL adapter walks each ownership chain with one lookup per hop. A snapshot has no keys to start from, so it needs a query over whole sets of rows. `sync-server` gains a function that returns each model's ownership chains without a key. `sync-server-sql` runs them as either:
  - **Relation filters:** `where: { OR: [{ board: { owner: { id: scopeKey } } }, …] }`, one branch per chain. This is the preferred approach.
  - **Top-down:** start from the root row, then fetch each model's rows whose foreign key is among the parent keys already collected. This is the fallback if the ORM's nested filters can't express the chains.

### The client

- **A new transport handler.** `fullSyncHandler(pageToken, signal, context)` returns one page. `createSyncFetchHandlers` gains `fullSyncUrl` and maps HTTP 410 from pull to a new `ResyncRequiredError`. The worker requires `fullSyncHandler`.
- **The worker switches to full sync when pull throws `ResyncRequiredError`.** It pulls snapshot pages in the same loop as normal pages: it pushes new local edits between pages and stops early if any are left to push.
- **Applying a page** uses raw writes, like `applyPull`, so no outbox events are created. For each record:
  - A row with a pending local change is skipped. The local edit wins until it is pushed.
  - Otherwise the row is written. Its version metadata gets `lastAppliedChangeId = snapshotCursor` and the current resync generation number.
- **The sweep runs after the last page.** It deletes every local row of a synced model whose metadata lacks the current generation, unless that row has a pending local change. This removes rows deleted on the server while their delete entries were evicted. Local-only stores are never touched.
- **A resync survives reloads.** The worker stores `{ generation, snapshotCursor, pageToken }` in sync metadata after each page. After a reload it continues from the stored token. When the sweep finishes, it sets the pull cursor to `snapshotCursor` and clears the stored state.
- **Events.** Each snapshot page emits `pullcompleted` with `resync: true`. The last page's event also lists the swept rows as deletes in `changes`, so apps can invalidate their queries. No new event types are added. The status stays `"pulling"`.

## Why

- **One signal, one place.** Pull already sees every cursor, so it decides whether a client must resync. The client needs only one new rule: on 410, switch endpoints.
- **The watermark is cheap and safe.** One small row is read per pull, with no lookup per cursor.
- **The sweep needs no list of keys.** Stamping a generation in version metadata uses storage that already exists, and memory stays constant however large the snapshot is.

## Alternatives considered

- **Resync when the cursor's changelog row no longer exists.** This is safe for the same reason as the watermark. But a scope with no changelog rows has no real cursor to hand out after a snapshot, so the client would get 410 on every pull. It also needs one lookup per pull.
- **Compact the changelog to the latest entry per row instead of deleting by age.** First syncs get smaller, but the changelog still grows with the number of records ever created, and deletes need tombstones. The row-version table from ADR 026 could later serve this role, if age-based deletion turns out not to be enough.
- **Wipe the local database and download everything.** It is simpler, but it loses pending local edits and local-only data, and the app sees every row vanish and reappear.
- **Return the snapshot in one response.** Memory and request timeouts would grow with the user's data.
- **Run the snapshot in one long transaction.** It holds a database snapshot across HTTP requests. The snapshot cursor already makes separate pages safe.

## Consequences

- Retention must not be turned on before ADR 026 is in place. Duplicate push detection depends on changelog rows. Without the version check, a push re-sent after its changelog row is deleted is applied again.
- The worker gains a required `fullSyncHandler` and apps gain a third route. This is a breaking change.
- The ownership query for whole sets of rows is new server code, and it needs its own tests against real Postgres, covering several ownership chains.
- A first sync now costs one pull request that returns 410, then the snapshot pages.
- Ownership changes keep their current limitation. A client only learns about a change of owner when a changelog row for that record comes up.

## Related

- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): the ownership chains the snapshot query follows.
- [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md): reconciling the local row to the server row.
- [ADR 026](ADR%20026%20-%20Stale%20Writes%20Are%20Rejected%20by%20Base%20Version.md): the version check that retention depends on.
