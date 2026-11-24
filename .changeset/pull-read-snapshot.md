---
"@prisma-idb/sync-server-sql": minor
---

Pass the top-level SQL client to `pull` and `resolvePullRecord`. A custom client must open a top-level transaction and honor `{ isolationLevel: "RepeatableRead" }`. A Prisma transaction scope cannot open the required snapshot.

A pull now reads its changelog page, the rows and their ownership chains in one transaction, at `REPEATABLE READ` on PostgreSQL. Custom pulls through `resolvePullRecord` and records returned with rejected pushes use the same isolation. Before, each read was a separate statement, so a write committed during the pull could pair a row with an ownership graph that never existed at the same time.

The reads in that transaction run one after another, and hold one connection for the page. The number of queries grows with the page size and the number of ownership hops. The default page size is 50. Lower `pullLimit` (or `limit`) if pages are slow or you have a small connection pool.
