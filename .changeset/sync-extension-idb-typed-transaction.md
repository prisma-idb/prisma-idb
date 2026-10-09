---
"@prisma-idb/sync-extension-idb": minor
---

Add `transaction(rootKeys, async (tx) => ...)` to the sync client. It groups several ORM calls in one IndexedDB transaction and records an outbox event for each tracked write in that same transaction. `outboxwrite` listeners run once after the commit, and never after a rollback. `withTransaction()` stays raw and records no outbox events.
