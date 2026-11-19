---
"@prisma-idb/client-idb": minor
---

Make `updateAll()`, `updateCount()`, `deleteAll()` and `deleteCount()` follow Prisma 8's rules for bulk writes:

- A bulk write on an accessor without `where()` is now a type error. At runtime it still changes every row, as in Prisma 8. To change every row on purpose, call `where({})`.
- A bulk write on an accessor with `skip()` or `take()` now throws `IdbBulkWriteError` before it writes anything. Before, it ignored both and changed every matching row, so `take(1).deleteCount()` deleted every row that matched.

`IdbStoreAccessor` has a fifth type parameter, `TFiltered`, which `where()` sets to `true`. A filtered accessor is still assignable to an unfiltered one.
