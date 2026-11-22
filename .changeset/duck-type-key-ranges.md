---
"@prisma-idb/sync-extension-idb": patch
---

A pulled delete that cascades no longer halts the pull in a realm without a global `IDBKeyRange`, such as one using fake-indexeddb's `IDBKeyRange` through the `keyRange` option. Tracked deletes in that realm no longer fail either. The sync extension recognizes key ranges by shape instead of with `instanceof IDBKeyRange`.
