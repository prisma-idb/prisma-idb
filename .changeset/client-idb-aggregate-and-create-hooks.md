---
"@prisma-idb/client-idb": patch
---

Fix three edge cases. `aggregate` no longer throws a `RangeError` from `min` or `max` over a very large result. `create()` now ends its middleware activity, so `activityEnded` runs. Enum list fields and list columns keep working when a contract stores list cardinality as an object instead of `true`.
