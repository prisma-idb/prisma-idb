---
"@prisma-idb/family-idb": patch
---

A required one-to-one relation over a nullable field now fails with `IDB_INVALID_RELATION`, as a required many-to-one relation already does.
