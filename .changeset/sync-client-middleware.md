---
"@prisma-idb/sync-extension-idb": minor
---

`createSyncIdbClient`, `createAutoMigratingSyncIdbClient` and the managed sync client accept `middleware` and pass it to the client's runtime, as `createIdbClient` does. Before, the auto-migrating sync client accepted the option and dropped it.
