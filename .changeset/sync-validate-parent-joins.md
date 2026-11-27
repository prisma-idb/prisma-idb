---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

Sync now refuses an ownership relation that joins its parent on a column other than the parent's primary key, for every operation and for pulls. Before, only creates and updates, and `createSqlSyncAdapter` when you passed it a `syncServer`, checked this. A delete, a pull, or a custom adapter's pull read the parent by primary key using the foreign key's value, so a join to another unique column, such as `User.email`, could authorize the wrong row.

`validatePush` and `buildPullQueries` now throw `Unsupported tenant parent join "Profile.user": expected a single-field FK to the parent's key.` for such a relation. The SQL adapter's `applyPushEvent` and `resolvePullRecord` throw it before they open a transaction, even when you pass your own check. To fix the error, make the relation reference the parent's single-field primary key.
