---
"@prisma-idb/sync-server-sql": patch
---

Encode non-finite PostgreSQL Float values as exact text on the sync wire, including keys and list members. Refuse overflowing JSON number literals before they reach validation or a changelog write.
