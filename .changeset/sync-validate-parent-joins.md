---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

Sync now refuses an ownership relation that joins its parent on a column other than the parent's primary key, for every operation and for pulls. Before, `validatePush` refused it only for creates and updates. The SQL adapter's ownership walk reads each parent by primary key using the foreign key's value, so a delete or a pull through such a join could authorize the wrong row when you used the adapter with your own check or server. (`createSqlSyncAdapter` already refused such a contract at startup when you passed it a `syncServer`.)

`validatePush` and `buildPullQueries` now throw `Unsupported tenant parent join "Profile.user": expected a single-field FK to the parent's key.` for such a relation. The SQL adapter's `applyPushEvent`, `resolvePullRecord`, pull and push reconciliation throw it before they walk ownership, even when you pass your own check or server. `applyPushEvent` still returns `KEYPATH_VALIDATION_FAILURE` first when the event's key differs from the check's key. To fix the error, make the relation reference the parent's single-field primary key.
