---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

Numeric tenant keys now match their string scope keys. PostgreSQL pull restores numeric keys from changelog text before reading records and sends numbers so IndexedDB can apply creates, updates and deletes. Existing changelog rows work without a backfill.
