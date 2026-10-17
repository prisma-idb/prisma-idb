---
"@prisma-idb/sync-server": minor
---

Build on Prisma 8 `8.0.0-rc.18`. `sqlContractWithSync` creates the PSL binder and passes the target's default namespace. The Postgres sync config declares its `DateTime` constructor by codec only, because contract columns store a data type instead of a native type.
