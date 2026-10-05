---
"@prisma-idb/client-idb": minor
---

Use planned key and index ranges for mutation lookups, bulk writes, upsert, nested relation writes and referential actions. Reapply the full filter before each write. Collect matches before changing the walked index so each row is written once, within the same transaction.
