# ADR 023: Migrations rewrite pending outbox payloads

- **Status:** Accepted.
- **Date:** 2026-10-08
- **Area:** Migrations, Sync
- **Updated:** 2026-11-24: a model rename passed to `migration plan --rename` now moves queued outbox events to the new name.

## Summary

When a `transformRecords` migration rewrites a model's store, the sync extension rewrites that model's queued outbox payloads with the same transform, in the same upgrade transaction. The store and the outbox commit together or roll back together. An unsent edit survives the migration instead of being rejected by the server.

## Context

[ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md) rewrites the records in an app store. It does not touch the sync outbox, which holds edits the client has not pushed yet.

An outbox payload has the shape of the model at the time of the edit. After a migration that renames a field, a queued `create` still carries the old field name. When the client pushes it, the server (already migrated) rejects it as invalid. The rejection is non-retryable, so [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md) replaces the local row with the server row. The user's unsent edit is lost.

## Decision

- **A hook on the extension space.** `IdbExtensionSpace` has an optional `onTransformRecords(tx, op, modelName, onDone)`. It runs after the store applies a `transformRecords` op, in the same upgrade transaction and before the next op.
- **`target-idb` stays outbox-agnostic.** `openAndUpgrade` takes one optional callback, `onTransformRecords(tx, op, onDone)`. `client-idb` supplies it. It resolves the model at each app operation using the stored renames and the head contract, then runs each extension's hook in turn. It skips operations from extension stores.
- **The sync extension rewrites matching events.** Its hook walks the outbox store with a cursor and rewrites an event only if `!synced && entityType === model`. That covers pending events and events the server rejected for good (`retryable === false`):
  - `create`: transform `payload` in `full` mode, the same mode that rewrites a stored record.
  - `update`: transform `payload.patch` in `patch` mode. `payload.key` is untouched. In `patch` mode a missing field stays missing, and a patch emptied by `removeFields` stays queued as a no-op update.
  - `delete`: keep the key payload. A model rename still updates the event’s model name and version metadata reference.
- **A rejected event is rewritten on a best-effort basis.** [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md) keeps rejected events as the only recovery record, so an app can resurrect one later. Rewriting it keeps that record in the current shape. A rejected event never gets pushed, and it may have been rejected because a value was invalid. If the transform throws on one, the payload stays as written and the upgrade goes on. The hook sets `migrationError` to the transform's error message and keeps the server rejection reason in `lastError`. Later successful transforms keep an existing marker: they cannot prove that an earlier skipped transform was repaired. An absent or `null` marker means no transform failure was recorded. A pending event that throws still aborts the upgrade.
- **Other events stay byte-for-byte unchanged.** This covers events that are already synced and events of other models.
- **One transform gives the same result in both places.** Outbox payloads hold the same encoded values as the store, so the transform needs no outbox-specific logic.
- **A failure on a pending event aborts everything.** If the transform throws on a pending payload, the hook calls `onDone(error)`. The upgrade aborts, the database stays at its old version, and the open request rejects with the original error. The store, the outbox and the markers are all unchanged.
- **No `await`.** The hook chains through IDB events on the upgrade transaction ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)). [ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md) applies extension ops before app ops, so the outbox store exists when the hook runs.

## Alternatives considered

- **Teach `target-idb` the outbox format.** Rejected. It couples the IDB target to one extension.
- **Reject the migration while the outbox holds events for the model.** Rejected. It forces the user to go online and flush before an app update.
- **Rewrite the outbox after the upgrade, in a separate transaction.** Rejected. A crash between the two leaves a migrated store with unmigrated events, which is the bug this decision fixes.

## Consequences

- Adding nullable `migrationError` and the missing nullable `versionMetaId` to the outbox contract changes `storageHash`. Contract emission and migration planning create a migration with no operations. Old rows read missing nullable fields as `null`; no backfill or separate data-migration progress is needed.

- A second extension that stores model-shaped data can use the same hook.
- The cost grows with the outbox size, because each `transformRecords` op for a synced model walks the whole outbox.

## Known limits

These limits assume the server checks the storage hash, which is the default ([ADR 015](ADR%20015%20-%20Contract-Derived%20Validation.md)). The storage hash covers model names, fields, value objects and enums.

- **An in-flight push can lose its acknowledgement across a rename.** If the server has already migrated, the storage-hash check returns 409 and the events stay queued. If the old server commits the push before the client receives the acknowledgement, the upgraded client may retry the same event ID under the new model name. A server that compares replay identity by model and payload fingerprint rejects this retry as a reused event ID. The original push already committed.
- **Explicit same-store model renames move queued edits.** `migration plan --rename Old:New` stores both names in `renameModel`. The hook uses those names even if a later migration drops the store or reuses its name. It moves unsynced events and version metadata in the same upgrade transaction. If the destination name has retained outbox events or version metadata, the upgrade aborts so old events cannot target the renamed model.
- **Server changelog rows keep their model names.** Rename the server model in the same release. Pulls classify earlier rows under the old name as `unknown-model`. Devices behind on pulls can miss those changes.
- **The storage hash checks shape, not values.** If the client and server migrations produce the same fields from different values, the storage hash matches and the server accepts the events. Write both migrations to produce the same values.
- **Turning the check off removes the protection.** With `contractCheck: "off"`, a push that does not match the server's contract is rejected as invalid, and the client replaces the local row with the server row ([ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md)). The unsent edit is lost. Only turn the check off if your deploys keep clients and server on one contract.
- **Repeated 409s count as failed tries.** Each refused push adds a try and a backoff to every event in the batch. After 10 tries the worker reports the outbox as stalled, but it never drops the events.

## Related

- [ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md): the operation this decision extends.
- [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md): what happens to an event the server rejects.
- `family-idb/src/core/extension-space.ts`: the hook type.
- `client-idb/src/core/auto-migrate.ts`: the model mapping and hook sequence.
- `sync-extension-idb/src/core/transform-outbox.ts`: the outbox rewrite.
