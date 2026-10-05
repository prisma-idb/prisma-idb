---
"@prisma-idb/driver-idb": minor
---

Add index, key range and direction to the plan vocabulary. Breaking changes:

- Rename the `index-get` plan to `get-all` (`IdbIndexGetPlan` is now `IdbGetAllPlan`) and its error code `INDEX_GET_FAILED` to `GET_ALL_FAILED`. `get-all` takes an optional `indexName`, `range` and `count`. Without `indexName` it reads the store, and without `range` it reads everything.
- Every `range` field on `get-all`, `cursor-scan`, `count` and `keys` is now an `IdbKeyRangeDescriptor`, a plain object with bounds and open flags, instead of an `IDBKeyRange`. The driver builds the `IDBKeyRange` when it runs the plan.
- `cursor-scan` `direction` accepts only `next` and `prev`.

New fields: `scan-write` takes an optional `indexName` and `range`. A `cursor-scan` or `scan-write` with `take: 0` now returns no rows without opening a cursor, so `scan-write` no longer writes one row.
