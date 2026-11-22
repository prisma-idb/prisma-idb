---
"@prisma-idb/sync-server": patch
---

A one-to-one relation that owns its foreign key, such as `UserProfile.user` with `userId String @unique`, now carries sync ownership to the root. Before, only many-to-one relations did, so such a model had no path to the root and `createSyncServer` refused the schema. The owning side is the one whose SQL table declares the foreign key.
