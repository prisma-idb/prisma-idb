---
"@prisma-idb/target-idb": patch
---

A `Json` field now accepts only values JSON can represent: `null`, strings, booleans, finite numbers, and arrays and plain objects of those. Before, IndexedDB stored any value, such as a `Map`, which sync then sent as `{}` and a SQL server stored differently.
