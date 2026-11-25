---
"@prisma-idb/client-idb": patch
---

Read contract markers together when planning or retrying an IndexedDB migration. A retry succeeds only if one committed snapshot shows every requested space at its head.
