---
"@prisma-idb/driver-idb": patch
---

Roll back transaction scopes when an object store lookup fails so earlier writes cannot commit after the error. Preserve transaction-inactive error handling.
