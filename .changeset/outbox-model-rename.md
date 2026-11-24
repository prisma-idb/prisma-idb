---
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/target-idb": minor
"@prisma-idb/family-idb": minor
"@prisma-idb/client-idb": patch
---

A same-store model rename records both model names in `renameModel` and moves unsynced outbox events and version metadata in the upgrade transaction. The upgrade stops if the new name already has retained sync history. Rename the model on the server in the same release.
