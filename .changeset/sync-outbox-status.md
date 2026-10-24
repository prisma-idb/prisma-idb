---
"@prisma-idb/sync-extension-idb": minor
---

Add `outbox.hasPending()`, `outbox.pendingCount()`, and committed `outboxchange` notifications for tracked writes and push results.

Breaking: contract mismatches now emit only `contractmismatch`, without a duplicate `error` event. `forceSync()` still rejects and the worker still enters the error status.
