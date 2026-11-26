---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": minor
---

`createSqlSyncAdapter` and `createSqlSync` now require a PostgreSQL contract and throw at startup for other targets. The adapter uses PostgreSQL's public schema, codecs and transaction locks.
