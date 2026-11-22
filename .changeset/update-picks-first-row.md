---
"@prisma-idb/client-idb": patch
---

`update()` now changes the row that `first()` returns for the same chain. Before, it ignored `orderBy()`, `skip()` and `take()` and changed the first row in key order, so `orderBy({ serial: "desc" }).update(...)` could change the wrong row and `take(0).update(...)` changed a row. Now `orderBy()` and `skip()` pick the row, and after `take(0)` nothing changes and the result is `null`.

An update with a relation callback finds its row by the filter alone, so it now throws `IdbRelationUpdateError` on a collection with `orderBy()`, `skip()` or `take()`, as in Prisma 8.
