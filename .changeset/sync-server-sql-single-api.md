---
"@prisma-idb/sync-server-sql": minor
---

Breaking: the root export no longer includes the free functions `applyPush`, `pull`, `applyPushEvent`, `toSyncPushPayload`, `resolvePullRecord`, `checkAuthorization`, `resolveRootKeyViaPath` and `ormRootFor`, or the `OrmRoot` type. Use the methods on `createSqlSyncAdapter` instead. `sqlGetKeyField`, the default limits and the adapter's types stay.

Each pushed event is now decoded once, whether it arrives through `applyPush` or the adapter's `applyPushEvent`.

The adapter now passes `wireKey` to `validatePush`, matching the `SyncPushEvent` change in `@prisma-idb/sync-server`.
