---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

Numeric tenant keys now match their string scope keys. PostgreSQL pull restores numeric keys from changelog text before reading records and sends numbers so IndexedDB can apply creates, updates and deletes. Existing valid numeric changelog keys work without a backfill.

Push rejects a PostgreSQL `float4` primary key if storing it would round the key. Pull returns stored `float4` key values consistently in the changelog entry and the record.
