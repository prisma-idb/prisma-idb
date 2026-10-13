---
"@prisma-idb/sync-extension-idb": minor
---

Breaking change: rehash the sync contract to include stored field shapes. Bundle a no-op migration from the previous hash so existing outbox and sync metadata remain intact.
