---
"@prisma-idb/target-idb": patch
---

A `Json` field now accepts only values JSON can represent: `null`, strings, booleans, finite numbers, and arrays and plain objects of those. This narrows what writes accept: a `Map`, `Date`, `bigint` or class instance inside a `Json` value now fails validation, where before IndexedDB stored it and sync then sent it as `{}`. An object property set to `undefined` is still accepted, as in Prisma, since JSON drops the key. An `undefined` array element is rejected, because JSON would turn it into `null`. A value nested more than 1000 levels deep is rejected with a validation issue instead of overflowing the stack.
