---
"@prisma-idb/client-idb": minor
---

Read a nullable field that a stored row lacks as `null`, so adding a nullable field needs no walk over the stored rows. Filters, sorting, relation loads, grouping and the rows that updates return all see `null`.
