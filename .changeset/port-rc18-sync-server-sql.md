---
"@prisma-idb/sync-server-sql": minor
---

Build on Prisma 8 `8.0.0-rc.18`. Ownership row locks cast the key to the Postgres type of the column's data type, which replaces the removed `nativeType`. `@prisma/orm-postgres` is now an optional peer dependency, needed only on Postgres.
