# ADR 023: Migrations rewrite pending outbox payloads

- **Status:** Proposed (Accepted on merge)
- **Date:** 2026-10-08
- **Area:** Migrations, Sync

## Summary

When a `transformRecords` migration rewrites a model's store, the sync extension rewrites that model's queued outbox payloads with the same transform, in the same upgrade transaction. The store and the outbox commit together or roll back together. An unsent edit survives the migration instead of being rejected by the server.

## Context

[ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md) rewrites the records in an app store. It does not touch the sync outbox, which holds edits the client has not pushed yet.

An outbox payload has the shape of the model at the time of the edit. After a migration that renames a field, a queued `create` still carries the old field name. When the client pushes it, the server (already migrated) rejects it as invalid. The rejection is non-retryable, so [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md) replaces the local row with the server row. The user's unsent edit is lost.

## Decision

- **A hook on the extension space.** `IdbExtensionSpace` has an optional `onTransformRecords(tx, op, modelName, onDone)`. It runs after a `transformRecords` op finishes its store walk, on the same upgrade transaction, and before the next op.
- **`target-idb` stays outbox-agnostic.** `openAndUpgrade` takes one optional callback, `onTransformRecords(tx, op, onDone)`. `client-idb` supplies it. It maps the op's store to an app model through the app's head contract, then runs each extension's hook in turn. If the store belongs to no app model, such as an extension's own store, it skips the hooks.
- **The sync extension rewrites matching events.** Its hook walks the outbox store with a cursor and rewrites an event only if `!synced && retryable && entityType === model`:
  - `create`: transform `payload` in `full` mode, the same mode that rewrites a stored record.
  - `update`: transform `payload.patch` in `patch` mode. `payload.key` is untouched. In `patch` mode a missing field stays missing, and a patch emptied by `removeFields` stays queued as a no-op update.
  - `delete`: untouched. A delete carries only the key, and ADR 016 rejects transforms that name a key field.
- **Other events stay byte-for-byte unchanged.** This covers events that are synced, events abandoned after a non-retryable failure (`retryable === false`), and events of other models.
- **One transform gives the same result in both places.** Outbox payloads hold the same encoded values as the store, so the transform needs no outbox-specific logic.
- **A failure aborts everything.** If the transform throws on a queued payload, the hook calls `onDone(error)`. The upgrade aborts, the database stays at its old version, and the open request rejects with the original error. The store, the outbox and the markers are all unchanged.
- **No `await`.** The hook chains through IDB events on the upgrade transaction ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)). [ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md) applies extension ops before app ops, so the outbox store exists when the hook runs.

## Alternatives considered

- **Teach `target-idb` the outbox format.** Rejected. It couples the IDB target to one extension.
- **Reject the migration while the outbox holds events for the model.** Rejected. It forces the user to go online and flush before an app update.
- **Rewrite the outbox after the upgrade, in a separate transaction.** Rejected. A crash between the two leaves a migrated store with unmigrated events, which is the bug this decision fixes.

## Consequences

- A second extension that stores model-shaped data can use the same hook.
- The cost grows with the outbox size, because each `transformRecords` op for a synced model walks the whole outbox.

## Known limits

- **A push already in flight in another tab cannot be rewritten.** The upgrade waits for other tabs to close their connections, but a request already sent still carries the old shape. The server rejects it, and the client reconciles to the server row.
- **Model renames are out of scope.** The hook matches `entityType` against the current model name.
- **Server and client migrations must match.** The hook makes queued events fit the new client contract. If the server migration differs from the client migration, the server still rejects the events.

## Related

- [ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md): the operation this decision extends.
- [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md): what happens to an event the server rejects.
- `family-idb/src/core/extension-space.ts`: the hook type.
- `client-idb/src/core/auto-migrate.ts`: the model mapping and hook sequence.
- `sync-extension-idb/src/core/transform-outbox.ts`: the outbox rewrite.
