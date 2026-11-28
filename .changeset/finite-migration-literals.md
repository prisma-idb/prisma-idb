---
"@prisma-idb/target-idb": patch
---

IndexedDB migrations reject non-finite numeric literals before emit or application, including hand-written transforms and values inside pipes. JSON would otherwise store the non-finite value as null.
