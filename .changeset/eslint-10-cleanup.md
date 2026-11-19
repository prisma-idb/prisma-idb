---
"@prisma-idb/idb-client-generator": patch
"@prisma-idb/family-idb": patch
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-extension-idb": patch
---

Attach the original error as `cause` when `createSyncServer` rejects a record validator and when contract publication fails and cannot be restored. Remove unused assignments, including one line in the generated client's push handler. Behavior is otherwise unchanged.
