---
"@prisma-idb/sync-extension-idb": minor
---

Queued writes are now pushed in the order they committed, across reloads, tabs and clock changes. Before, the order came from a timestamp that only increased within one page load. After a reload under an earlier clock, a child's create could be pushed before its parent's and be rejected.

The sync extension adds a store, `_idb_sync_outbox_order`. Each queued write adds a row to it in the same transaction, and IndexedDB's key generator numbers the rows. Apps that open the database with `createAutoMigratingSyncIdbClient` get the store through the extension's new migration the next time they open it. An app that applies migrations itself must apply that migration before it opens `createSyncIdbClient`, since every tracked write and push now uses the store. Writes queued before the upgrade are pushed first, in their previous order.
