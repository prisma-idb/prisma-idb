---
"@prisma-idb/client-idb": patch
---

A filter on a field the model doesn't have now throws `Model "<Model>" has no field "<field>"`, as in Prisma 8. This covers `where()` with an object or a function, `upsert()`, and `connect()` and `disconnect()` criteria. Before, an unknown field read as missing on every row, so `where({ typo: null })` matched every row, and a bulk write with it changed every row.
