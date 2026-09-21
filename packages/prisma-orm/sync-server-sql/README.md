# @prisma-idb/sync-server-sql

SQL execution adapter for `@prisma-idb/sync-server`. `sync-server` resolves ownership _decisions_ (`OwnershipCheck`s) but never touches a database — this package is the piece that actually applies an authorized push event to real SQL tables, or re-fetches a record's current state for a pull, against a generated Prisma 8 SQL ORM client (Postgres, SQLite, ...).

Server-only, same as `sync-server` — never ships to the browser.

## Installation

```bash
pnpm add @prisma-idb/sync-server-sql
```

## Quick Start

Build one `sqlSyncAdapter` per app, alongside `sync-server`'s own `createSyncServer` — both take the same real SQL contract and share the same `getKeyField` resolver, since the default `sync-server` ships (`defaultGetKeyField`) assumes IDB's flat `storage.keyPath`, which a SQL contract doesn't have:

```ts
// src/lib/server/sync.ts
import { createSyncServer } from "@prisma-idb/sync-server";
import { createSqlSyncAdapter, sqlGetKeyField } from "@prisma-idb/sync-server-sql";
import type { Contract as ServerContract } from "../prisma/schema.postgres.generated";
import type { Contract as ClientContract } from "../prisma/contract";
import serverContractJson from "../prisma/schema.postgres.generated.json" with { type: "json" };
import clientContractJson from "../prisma/contract.json" with { type: "json" };

const serverContract = serverContractJson as unknown as ServerContract;

export const syncServer = createSyncServer({
  contract: serverContract,
  clientContract: clientContractJson as unknown as ClientContract,
  rootModel: "User",
  getKeyField: sqlGetKeyField, // SQL's key lives on the table, not the model — see sync-server's README
});

export const sqlSyncAdapter = createSqlSyncAdapter({ contract: serverContract });
```

Push endpoint — resolve checks with `syncServer`, apply them with `sqlSyncAdapter`:

```ts
// src/routes/api/sync/push/+server.ts
const pushEvents = events.map((e) => ({
  id: e.id,
  model: e.entityType,
  operation: e.operation,
  payload: sqlSyncAdapter.toSyncPushPayload(e.operation, e.payload, sqlSyncAdapter.getKeyField(e.entityType)),
}));
const checks = syncServer.validatePush(pushEvents, { scopeKey });

const results = [];
for (const { eventId, model, check } of checks) {
  // Sequential, not Promise.all — a batch can carry data dependencies (a
  // Todo created right after the Board it belongs to); running concurrently
  // would race the Board's own not-yet-committed transaction.
  results.push(
    await sqlSyncAdapter.applyPushEvent(
      db,
      events.find((e) => e.id === eventId)!,
      model,
      check,
      scopeKey
    )
  );
}
```

Pull endpoint — same two-step shape `sync-server`'s README describes, with `resolvePullRecord` doing step 2's live re-fetch:

```ts
// src/routes/api/sync/pull/+server.ts
const checks = syncServer.buildPullQueries(pullLogs, { scopeKey });
const logs = await Promise.all(
  checks.map(async ({ changelogId, model, check }) => {
    const { operation, keyPath } = /* looked up from the pre-filtered row */;
    const record = await sqlSyncAdapter.resolvePullRecord(db, model, check, keyPath, operation);
    return { changelogId, model, operation, keyPath, record }; // record: null → applyPull treats as a local delete
  })
);
```

See `@prisma-idb/sync-server`'s README for the full push/pull contract (why checks are "descriptions", the two-step pull, the ownership-inside-the-transaction rule) — this package only covers execution against SQL.

## API

### `createSqlSyncAdapter({ contract, getKeyField? })`

Built once per app, not per request. Returns a `SqlSyncAdapter`:

- `getKeyField(model)` — the model's primary-key field name, via the configured resolver (`sqlGetKeyField` by default).
- `toSyncPushPayload(operation, payload, keyField)` — reshapes an outbox event's payload into what `sync-server`'s `validatePush` reads `payload[keyField]` from. `update`/`delete` payloads must carry `{ key }` pinning the row by equality; a filter that doesn't throws.
- `applyPushEvent(db, event, model, check, scopeKey)` — authorizes (inside the transaction, immediately before the write it gates) then applies one outbox event: writes the model row and a stamped `Changelog` row, atomically. Idempotent on `event.id` — a re-applied event is detected via the `Changelog` row and returns success without re-writing. Catches and logs the real error server-side, returning a generic, retryable `SqlPushResult` to the caller so DB-internal detail (constraint names, SQL fragments) never reaches the client.
- `resolvePullRecord(db, model, check, keyPath, operation)` — authorizes a pulled changelog row against its _current_ state, then re-fetches the record if allowed. Returns `null` for unauthorized, deleted, or `"delete"`-operation rows.

`db` must be a generated Prisma 8 SQL ORM client exposing `.transaction(fn)` (for `applyPushEvent`) and `.orm.public.<Model>` (both) — the same client your app already uses elsewhere.

### `sqlGetKeyField`

The `GetKeyField` resolver for SQL contracts: reads `contract.storage.namespaces[ns].entries.table[table].primaryKey.columns`. Only single-column primary keys are supported — a compound key throws rather than silently picking one column.

### Lower-level exports

Everything `createSqlSyncAdapter` composes is also available directly, for building against a different adapter shape:

- `applyPushEvent(db, contract, getKeyField, event, model, check, scopeKey)`, `toSyncPushPayload(operation, payload, keyField)` — from `./push`.
- `resolvePullRecord(db, contract, getKeyField, model, check, keyPath, operation)` — from `./pull`.
- `checkAuthorization(db, contract, getKeyField, model, check, startRow)`, `resolveRootKeyViaPath(...)` — the `OwnershipCheck` → boolean walk, one relation hop at a time via sequential `first()` lookups (not a nested relation-filter query).
- `ormRootFor(db, model)` — the runtime, string-keyed `db.orm.public[model]` lookup every generated Prisma 8 SQL client supports the same way; throws if `model` isn't found.
