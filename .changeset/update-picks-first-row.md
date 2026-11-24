---
"@prisma-idb/client-idb": patch
---

`update()` now changes the first row of the chain, in the order and after the offset that `orderBy()` and `skip()` set. Before, it ignored `orderBy()`, `skip()` and `take()` and changed the first row in key order, so `orderBy({ serial: "desc" }).update(...)` could change the wrong row and `take(0).update(...)` changed a row. Now `orderBy()` and `skip()` pick the row, and after `take(0)` nothing changes and the result is `null`.

An update with a relation callback finds its row by the filter alone, so it now throws `IdbRelationUpdateError` on a collection with `orderBy()`, `skip()` or `take()`, as in Prisma 8.

After `take(0)`, `update()` still validates its data and throws `IdbRecordValidationError` for an invalid patch, as Prisma does before it looks for a row. Before, it returned `null` without checking. Foreign-key and `onUpdate` checks need a row, so they still don't run. This is a behavior change for code that relied on `take(0).update(invalid)` returning `null`.
