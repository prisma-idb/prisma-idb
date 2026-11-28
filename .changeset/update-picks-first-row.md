---
"@prisma-idb/client-idb": patch
---

`update()` now changes the row that `first()` would return for the same chain. Before, it ignored `orderBy()`, `skip()` and `take()` and changed the first row in key order.

- `orderBy()` and `skip()` choose the row. For example, `orderBy({ serial: "desc" }).update(...)` changes the row with the highest `serial`.
- After `take(0)`, no row changes and `update()` returns `null`. Before, it changed a row. It still validates the data and throws `IdbRecordValidationError` for an invalid patch. Foreign-key and `onUpdate` checks run only when a row is picked.
- An update with a relation callback, such as `posts: (p) => p.connect(...)`, finds its row by the filter alone. It now throws `IdbRelationUpdateError` if the chain has `orderBy()`, `skip()` or `take()`. To fix the error, remove them or filter to one row, such as by `id`.
- On a chain with `orderBy()` or `skip()`, foreign keys are checked on the row the update picks, so a missing parent throws only when that row is written. A plain update still checks the foreign keys in its data first, so it can throw when no row matches.
- `orderBy({})` sorts by nothing and counts as no order for every kind of update.
- An update with a relation callback on an unfiltered chain, such as `where({})`, now changes the first row in key order. Before, it returned `null` and changed nothing.
