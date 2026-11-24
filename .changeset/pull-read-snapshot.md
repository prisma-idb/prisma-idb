---
"@prisma-idb/sync-server-sql": minor
---

Breaking: `db` passed to `pull` or `resolvePullRecord` must now support `transaction()`, as the Prisma 8 SQL clients do. A custom `db` object that only exposes `orm.public` and no `transaction` now fails on either method. `applyPush` already required it.

A pull now reads its changelog page, the rows and their ownership chains in one transaction, at `REPEATABLE READ` on PostgreSQL. Custom pulls through `resolvePullRecord` and records returned with rejected pushes use the same isolation. Before, each read was a separate statement, so a write committed during the pull could pair a row with an ownership graph that never existed at the same time.

The reads in that transaction run one after another, and hold one connection for the page. The number of queries grows with the page size and the number of ownership hops. The default page size is 50. Lower `pullLimit` (or `limit`) if pages are slow or you have a small connection pool.
