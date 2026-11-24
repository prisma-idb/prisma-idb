---
"@prisma-idb/client-idb": patch
---

`take()` and `skip()` now throw a `RangeError` unless the value is an integer from 0 to `Number.MAX_SAFE_INTEGER`, using the same numeric bounds as Prisma 8 SQL. The error is also a `RangeError` for nonnumeric JavaScript inputs. Before, a negative value gave different results depending on the access path: `take(-1)` returned no rows from a scan and two rows from a primary-key lookup.
