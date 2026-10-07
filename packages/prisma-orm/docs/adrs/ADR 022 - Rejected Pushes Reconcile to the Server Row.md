# ADR 022: Rejected pushes reconcile to the server row

- **Status:** Proposed (Accepted on merge)
- **Date:** 2026-10-07
- **Area:** Sync

## Summary

When the server rejects a pushed event for good, the client replaces its local row with the server's row. The push result carries that row as `record`, or `null` if the row does not exist for the caller. The client never keeps a local write the server refused. If two devices create the same natural key, the second device's write is removed. The rejected event stays in the outbox as a record of what the user wrote.

## Context

A push can fail in two ways. A retryable failure, such as a lost connection or a deadlock, can succeed later, so the client keeps the event and tries again. A non-retryable failure never can: a unique violation, a foreign-key violation, a scope violation, or a record that fails validation.

Before this decision the client marked a rejected event dead and cleared its pending flag, but it left the local write in place. The client then held a row that the server did not have and never would. The client and the server diverged, and no later pull repaired it, because the pull only delivers rows that change on the server.

The server also treated every database error as retryable. A unique violation therefore looped forever, and because the outbox pushes in order, it blocked every later event.

## Decision

- **One rule: `local row := record`.** `record` is the row's current state for the caller, as `pull` would return it. A row replaces the local row. `null` deletes it. This covers all three operations:
  - A rejected create is undone, because the server has no such row.
  - A rejected update is replaced by the server's row.
  - A rejected delete restores the row if it still exists, and does nothing if it is already gone.
- **The server supplies `record`.** `applyPush` attaches it to every non-retryable failure whose key it can decode. It reads the row with the same ownership check as `pull`, so `record` never exposes a row the caller could not already pull.
- **The client validates before it writes.** It decodes `record` and checks it against the client contract, as it does for a pulled row. A `record` that is missing or invalid leaves the local write in place and counts the event as `unreconciled`. A later pull is the only repair.
- **The write is raw and atomic.** It adds no outbox event and runs no referential actions. It runs in the same transaction that records the failure, so the pending flag never clears while the rejected write remains.
- **The server classifies database errors by SQLSTATE.** Class 22 (data exception) and class 23 (integrity constraint violation) are non-retryable. Every other error, including an error with no SQLSTATE, stays retryable. When in doubt, the client stalls rather than discards data.
- **The rejected event stays in the outbox.** It is marked dead (`retryable: false`) and keeps its full payload, so the app can recover what the user wrote.

## Why

- **No divergence.** The sync model promises that the client is a prefix of the server's history, plus pending local edits. A refused write that stays visible breaks that promise silently.
- **One rule is easy to verify.** Per-operation logic would triple the cases to test. Replacing the row works for every case, including the ones we did not enumerate.
- **Reads reuse the pull path.** The ownership check and the key decoding already exist and are tested. Nothing new can leak.

## Trade-off: reject and reconcile loses the second write

This model favors relational schemas with a single authority. It does not merge concurrent edits as a CRDT would.

Example: two devices of one user each create a board named "Home" while offline, and the schema has `@@unique([ownerId, name])`. Both fill the board with todos. The first device to push wins. The server rejects the second board with a unique violation, and the second device deletes its board and, after the todos are rejected too, its todos. The user's work on the second device is gone from view. It remains only in the rejected events in the outbox.

Rules that follow:

- **Avoid user-chosen natural-key uniques on models that clients create offline.** Use a surrogate id as the primary key. Put a uniqueness rule on the server only if losing the second write is acceptable.
- **Never prune rejected events from the outbox.** They are the only recovery record.

## Alternatives considered

- **Keep the local write and surface an error.** The client then shows data the server does not have. The app must resolve every case by hand. Rejected.
- **Return the conflicting row and merge into it.** For the "Home" example, this would move the second device's todos into the first board. It needs per-model merge rules and a way to re-parent children. Deferred; it can be added later without changing this wire format.
- **CRDT merge.** It never rejects, but it replaces the relational model, constraints and ownership checks that this library is built on. Rejected.
- **Cap retries, then discard the event.** A cap turns a long outage into silent data loss. The client keeps a retryable event indefinitely and reports a `stalled` signal instead.

## Consequences

- The push wire format gains an optional `record`. A client that does not know it ignores it. A server that does not send it makes the client fall back to the old behavior and count the event as `unreconciled`.
- The server's `applyPush` does one extra read per non-retryable failure.
- A follow-up should add a read-only `listRejectedEvents()` and a how-to for recovering rejected writes, and a contract-emit warning for non-primary-key `@unique` on synced client models.

## Related

- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): how sync authorizes records.
- [ADR 020](ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md): why a key is a stable identity for reconciliation.
