---
"@prisma-idb/sync-extension-idb": patch
---

Automatically retain the newest 100 acknowledged outbox events by creation time in the sync worker. Keep all unsent and failed events and version metadata. Direct calls to low-level outbox helpers do not prune history.
