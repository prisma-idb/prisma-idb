---
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

After a delete or update lands, the client checks every foreign key that its referential actions changed. This also covers overlapping compound foreign keys, such as two keys that share a tenant ID. A failed check rolls back the whole write.
