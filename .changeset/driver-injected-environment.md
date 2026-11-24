---
"@prisma-idb/driver-idb": patch
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

A driver given its own `factory` now compares keys and builds key ranges with that implementation, not the global one. Before, an update in a realm without a global `indexedDB`, such as a test using fake-indexeddb's `IDBFactory`, failed with `PUT_FAILED`, and range queries used the global `IDBKeyRange`. Pass the matching `IDBKeyRange` as the new `keyRange` option of `createIDBRuntimeDriver`, `createIdbClient`, `createAutoMigratingIdbClient`, `createSyncIdbClient` or `createAutoMigratingSyncIdbClient` when the global scope has none.
