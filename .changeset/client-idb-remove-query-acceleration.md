---
"@prisma-idb/client-idb": minor
---

Remove the indexed-equality, OR multi-scan, native-count and key-only fast paths. Every read, count, existence check and mutation lookup now scans the store and filters in memory. Only `findUnique` on the primary key still reads by key. Results are unchanged, but without `orderBy` the row order is now unspecified, as in Prisma. Add `orderBy` wherever you rely on an order, including with `first()`, `skip()` and `take()`.
