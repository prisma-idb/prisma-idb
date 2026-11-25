---
"@prisma-idb/sync-extension-idb": patch
---

The sync worker now scans the outbox once per batch of push results, not once per acknowledged or rejected event, when it checks for other pending edits of the same row. `markSynced` and `markFailed` still read the outbox for each event, so a caller that queues a new edit between two calls keeps that row's pending flag.
