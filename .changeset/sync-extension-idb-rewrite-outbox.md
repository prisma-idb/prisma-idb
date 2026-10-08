---
"@prisma-idb/sync-extension-idb": minor
---

Rewrite pending outbox payloads when a migration transforms a model's records. Unsent `create` and `update` events keep working after a rename, retype or backfill. Synced, abandoned and other-model events stay unchanged, and a failing transform rolls back the store and the outbox together.
