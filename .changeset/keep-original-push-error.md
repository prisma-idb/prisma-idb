---
"@prisma-idb/sync-extension-idb": patch
---

When a push fails and recording the failed attempt also fails, the worker now reports the push failure, and logs the second failure with `console.error`. Before, the second error replaced the first, so the `error` event and the rejected `forceSync()` named the bookkeeping failure instead of the transport failure. A tracked transaction that queues a very large number of outbox events no longer rejects after it has committed.
