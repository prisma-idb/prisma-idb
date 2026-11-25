---
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

`SetNull` and `SetDefault` trigger the child's own `onUpdate` actions for the fields they change. A refusal anywhere in the chain identifies the delete or update that you called.
