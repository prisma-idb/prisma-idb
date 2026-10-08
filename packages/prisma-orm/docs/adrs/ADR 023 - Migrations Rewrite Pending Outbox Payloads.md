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

These limits assume the server checks the contract fingerprint, which is the default ([ADR 015](ADR%20015%20-%20Contract-Derived%20Validation.md)). The fingerprint covers model names, fields, value objects and enums.

- **A push already in flight in another tab is safe, because of the fingerprint.** The request carries the old contract's fingerprint. If the server has already migrated, it answers 409 before it validates anything. The worker marks the events as failed but retryable, so they stay queued, and the upgrade rewrites them. If the server has not migrated yet, it may apply the push. The old tab then cannot mark the events as synced, because its connection is closed. The rewritten events are pushed again, and the server treats the repeated event id as already applied.
- **Model renames are not rewritten.** The hook matches `entityType` against the current model name, so it skips events queued under the old name. While the client and server contracts differ, pushes get a 409 and the events wait. Once both sides are on the new contract, the server rejects the old name as an unknown model. That rejection is permanent and carries no row to reconcile to, so the local write stays until a pull overwrites it, and the unsent edit never reaches the server. Let the outbox drain before you ship a model rename.
- **The fingerprint checks shape, not values.** If the client and server migrations produce the same fields from different values, the fingerprint matches and the server accepts the events. Write both migrations to produce the same values.
- **Turning the check off removes the protection.** With `contractFingerprintCheck: "off"`, a push that does not match the server's contract is rejected as invalid, and the client replaces the local row with the server row ([ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md)). The unsent edit is lost. Only turn the check off if your deploys keep clients and server on one contract.
- **Repeated 409s count as failed tries.** Each refused push adds a try and a backoff to every event in the batch. After 10 tries the worker reports the outbox as stalled, but it never drops the events.

## Related

- [ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md): the operation this decision extends.
- [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md): what happens to an event the server rejects.
- `family-idb/src/core/extension-space.ts`: the hook type.
- `client-idb/src/core/auto-migrate.ts`: the model mapping and hook sequence.
- `sync-extension-idb/src/core/transform-outbox.ts`: the outbox rewrite.
