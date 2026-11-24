---
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/target-idb": minor
"@prisma-idb/family-idb": minor
"@prisma-idb/client-idb": patch
---

A migration that renames a model (`renameModel`) now moves unsynced outbox events and their version metadata to the new model name in the same upgrade transaction. An edit queued while a device was offline still reaches the server after the rename, instead of being rejected as an unknown model. Rename the model on the server in the same release.
