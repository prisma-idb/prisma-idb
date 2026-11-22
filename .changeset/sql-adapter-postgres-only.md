---
"@prisma-idb/sync-server-sql": patch
---

`createSqlSyncAdapter` and `createSqlSync` now refuse a contract that doesn't target PostgreSQL when they're created. The package was described as supporting SQLite, but it reads models through PostgreSQL's `public` schema and maps only PostgreSQL codecs, so a SQLite contract failed on its first push or pull. The README and package keywords no longer mention SQLite.
