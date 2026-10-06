# ADR 020: Primary keys are immutable

- **Status:** Accepted
- **Date:** 2026-10-06
- **Area:** Writes, Sync

## Summary

An update cannot change a row's primary key. `update()`, `updateAll()`, `updateCount()` and the update arm of `upsert()` reject a patch that would change the key. The error has the code `PRIMARY_KEY_CHANGE_UNSUPPORTED`, and the whole mutation rolls back. The generated update types also leave primary-key fields out, so TypeScript catches most attempts before they run. To change a key, delete the row and create a new one.

## Context

Prisma over SQL lets you update a primary key. The database moves the row, and `ON UPDATE` actions repoint child rows. Code ported from Prisma over SQL can therefore contain such updates, and the IndexedDB client had to decide what to do with them.

It had no decision, and that caused two bugs. An `updateAll` that changed the key hung, because the failure happened inside a cursor callback and never reached the caller. A keyed update inserted a second row and left the old row in place.

IndexedDB itself does not support moving a record. `IDBCursor.update()` throws a `DataError` if the new value changes the key. The only way to emulate a move is to write the new row and delete the old one.

## Decision

- **Reject key changes at runtime.** The driver compares the old and new key of each row it updates. If they differ, it throws `IdbExecuteError` with the code `PRIMARY_KEY_CHANGE_UNSUPPORTED` and aborts the transaction. Writes made earlier in the same call roll back, including referential actions and sync outbox and version entries. The message says that primary keys are immutable and tells the caller to delete the row and create a new one. See `driver-idb/src/core/execute/ops.ts`.
- **Allow a patch that repeats the key.** A patch may include the existing key, including a compound, date or binary key. Nothing changes, so nothing is rejected. An update that matches no rows writes nothing and does not throw.
- **Reject key changes at compile time.** The update input types for `update`, `updateAll`, `updateCount` and `upsert.update` exclude primary-key fields for models the contract resolves. A model name the contract cannot resolve keeps an untyped patch, so only the runtime check applies. Code that passes `id`, even the existing value, no longer compiles. Create inputs are unchanged. A dotted key path excludes its whole containing field, because a patch shallow-merges into the row.
- **Do not add key moves.** No option or flag turns key changes on.

## Why

- **Sync identity is the key.** The sync extension identifies a record by its model and primary key. The outbox, the version metadata and last-write-wins conflict resolution all use that pair. A key change would orphan the old identity's outbox events and versions, and the server would never learn that the two rows are the same record. Making keys immutable removes the question.
- **IndexedDB has no move.** A move is a delete plus an add, and the client would need extra machinery to make that look like an update (see the alternatives).
- **The decision is reversible.** Rejecting key changes now keeps the option to support them later. Supporting a half-correct move now and removing it later would break callers.
- **Failure is loud.** Before this decision, a key change hung or duplicated data without any error. A named error code, plus a compile-time error, shows the problem where the code is written.

### How other systems handle keys

SQL databases, and Prisma over SQL, allow primary-key updates. The database owns the row and the foreign-key constraints, so a move is one atomic operation.

Most stores without that machinery treat the key as fixed:

- **MongoDB** rejects an update to `_id`.
- **Firestore** has no way to rename a document. You copy the data to a new document and delete the old one.
- **CouchDB and PouchDB** identify a document by `_id`. Changing it means creating a new document and deleting the old one.
- **DynamoDB** does not let `UpdateItem` modify key attributes.
- **IndexedDB** rejects a cursor update that changes the key. `put()` with a different key writes a second record.
- **Local-first sync engines** generally treat record ids as stable, because a sync protocol that identifies records by id can't follow one that changes.

This client sits in the second group, so it follows the second group's rule.

## Alternatives considered

- **Split a key change into a delete and a create inside the client.** This looks simple, but a move is not a delete followed by a create:
  - A real delete runs `onDelete` actions. A move must skip them and run `onUpdate` on the referencing stores instead. The change then recurses whenever the foreign key is part of a child's own primary key.
  - IndexedDB needs `add`, not `put`, to catch a collision with an existing key. The client must also collect all matching rows before it writes any, because a cursor sees the writes of its own transaction.
  - In sync, the outbox would carry two unrelated events, a create and a delete. The server would have to create the new row, repoint its children, and then delete the old row. If another device edits the old key while offline, that edit either resurrects the old row or is lost, unless the server keeps an old-to-new redirect.
  - Allowing moves only when sync is off makes behavior depend on the mode. Code that works in development would fail in production, or the reverse.
- **Keep the old keyed-update behavior.** Before this decision, the client merged the new key into the row and wrote it with `put`. That wrote a second row under the new key and left the original row behind. Rejected.

## Consequences

- **Prisma over SQL differs here.** Code ported from Prisma over SQL can contain a key update. It now fails to compile, or fails at runtime if the types are bypassed. The fix is to delete the row and create a new one in one transaction.
- **`onUpdate: Cascade` rarely applies.** The action still runs when an update changes a non-key field that children reference, such as a `@unique` column. A primary-key change can't use it: the client applies the action before the store rejects the write, and the rejection rolls the action's effects back. The default `onUpdate` stays `restrict` ([ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)).
- **Natural and compound keys need care.** A model whose key is editable data, such as an email address or a slug, can't change that value. Give the model a surrogate `id` as its primary key and put the editable value in an `@unique` or `@@unique` constraint. Then the value can change and `onUpdate: Cascade` can follow it.

## Reversal

Key moves can return as a sync feature, with these parts:

- The server records a redirect from the old key to the new key.
- Deleted keys leave tombstones, so a late edit to the old key can be forwarded or refused.
- The outbox carries one move event instead of a create and a delete.
- Clients apply `onUpdate` on referencing stores in the same transaction as the move.

Until then, the immutable rule stays.

## Related

- [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md): why failures inside cursor callbacks must reach the caller's error handler.
- [ADR 006](ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md): why the driver reads every row inside the transaction before it returns any.
- [ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md): referential actions.
- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): how sync authorizes records.
- `driver-idb/src/core/execute/ops.ts`: the runtime check and error message.
- `driver-idb/src/core/execute/error.ts`: the `PRIMARY_KEY_CHANGE_UNSUPPORTED` code.
- `client-idb/src/core/types.ts`: the update input types that exclude primary-key fields.
- `client-idb/README.md` and `driver-idb/README.md`: user-facing notes.
