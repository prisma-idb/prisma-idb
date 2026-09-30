---
"@prisma-idb/sync-server-sql": patch
---

Pushes for the same scope are now serialized around the `Changelog` insert with a transaction-scoped Postgres advisory lock. Previously two concurrent pushes could commit their changelog rows out of id order, letting a pull in between advance its cursor past a row that then committed and never be seen. Different scopes don't contend, and there is no wire or type change.
