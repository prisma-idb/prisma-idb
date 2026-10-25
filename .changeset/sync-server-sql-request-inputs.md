---
"@prisma-idb/sync-server-sql": minor
---

Replace `createSqlSyncHandlers` with `createSqlSync`, which builds the server and SQL adapter and accepts lazy database and authenticated scope resolvers. Read the storage hash from request inputs and prevent pull caching. Breaking: deploy with the updated sync client.
