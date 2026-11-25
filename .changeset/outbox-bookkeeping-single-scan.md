---
"@prisma-idb/sync-extension-idb": patch
---

Recording a push result now scans the outbox once per batch. Before, each acknowledged or rejected event scanned the whole outbox again to check for other pending edits of the same row, so replaying a large offline queue cost time quadratic in its size. `markSynced` and `markFailed` still read the outbox for each event, so a caller that queues a new edit between two calls keeps that row's pending flag.
