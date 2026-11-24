---
"@prisma-idb/sync-server-sql": patch
---

Encode non-finite PostgreSQL Float values as exact text on the sync wire, including keys and list members. Refuse overflowing JSON number literals before they reach validation or a changelog write.

Deploy this server change and upgrade every pulling client to a version that accepts Float infinities before writing them to synced fields. Older clients reject these rows and permanently advance their cursor past them, even though the storage hash matches.
