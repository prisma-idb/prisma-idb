---
"@prisma-idb/driver-idb": patch
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

The driver compares primary keys using its IndexedDB factory. Pass the matching `IDBKeyRange` constructor as `keyRange` when the global constructor is missing or comes from a different IndexedDB implementation. The driver uses that constructor for query ranges. You can set it on `createIDBRuntimeDriver`, `createIdbClient`, `createAutoMigratingIdbClient`, `createSyncIdbClient` or `createAutoMigratingSyncIdbClient`.
