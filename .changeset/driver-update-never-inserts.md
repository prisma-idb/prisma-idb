---
"@prisma-idb/driver-idb": patch
---

Breaking: a driver `update` plan on a key with no row now writes nothing and returns no row. Before, it inserted the patch as a new row when the patch repeated the key. `put` is the operation that inserts. This matches the SQL and Mongo drivers, whose `UPDATE` and `updateOne` never insert. The client's own `update` calls read the row first inside the same transaction, so they are unaffected; only code that sends `update` plans straight to the driver changes.
