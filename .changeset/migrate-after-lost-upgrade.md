---
"@prisma-idb/client-idb": patch
"@prisma-idb/target-idb": patch
---

`createAutoMigratingIdbClient` now finishes migrating when a tab with an older build upgrades the database at the same moment, for example during a deploy. Before, the client could open with the older build's schema, and queries on new stores or indexes failed.

The client reads all migration markers in one transaction. After each upgrade, it reads them again and applies whatever is still pending. If other tabs keep upgrading the database, it stops with an error that asks you to close them.
