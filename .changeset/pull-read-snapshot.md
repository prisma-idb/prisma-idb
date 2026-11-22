---
"@prisma-idb/sync-server-sql": patch
---

A pull now reads its changelog page, the rows and their ownership chains in one transaction, at `REPEATABLE READ` on PostgreSQL. The record returned with a rejected push is read the same way. Before, each read was a separate statement, so a write committed during the pull could pair a row with an ownership graph that never existed at the same time. `db` passed to `pull` must support `transaction()`, as the Prisma 8 SQL clients do.
