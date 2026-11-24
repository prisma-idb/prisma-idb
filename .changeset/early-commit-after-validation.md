---
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

When a `db.transaction()` callback waits on a timer, IndexedDB commits the earlier writes. If the next operation then fails validation, the transaction now rejects with `IdbTransactionCommittedEarlyError`, with the validation error as its `cause` even if the callback catches it. Before, it could reject with the bare validation error, as if the earlier writes had rolled back.

A sync client now also announces those saved writes through `outboxwrite`. Before, its scope cleared the buffered notifications when the rollback was requested, even though the abort did nothing, so subscribers such as a pending-sync badge never heard about outbox rows that persisted. The scope now drops the notifications only when the commit fails.
