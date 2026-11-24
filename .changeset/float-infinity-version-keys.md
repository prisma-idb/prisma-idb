---
"@prisma-idb/sync-extension-idb": patch
---

Sync version metadata uses distinct IDs for positive and negative infinity keys so pending edits and pulled changes refer to the same record.

Upgrade the SQL sync server and every pulling client before writing infinities to synced fields. Older clients skip rows with infinite Float values and permanently advance their pull cursor past them. The storage hash stays the same.
