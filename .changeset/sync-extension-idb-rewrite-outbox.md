---
"@prisma-idb/sync-extension-idb": minor
---

Rewrite unsynced outbox payloads when a migration transforms a model's records. Unsent `create` and `update` events keep working after a rename, retype or backfill, and events the server rejected stay in the current shape so an app can still resurrect them. Synced and other-model events stay unchanged. A failing transform on a pending event rolls back the store and the outbox together. A rejected event that cannot be converted is kept as written.
