---
"@prisma-idb/sync-server-sql": patch
---

Internal cleanup of push and pull with no behavior change: wire value encoding and revival live in one module, the `Changelog` table is read and written through one module, and the pull files are named after what they export.
