---
"@prisma-idb/client-idb": patch
---

When a `db.transaction()` callback waits on a timer, IndexedDB commits the earlier writes. If the next operation then fails validation, the transaction now rejects with `IdbTransactionCommittedEarlyError`, with the validation error as its `cause`. Before, it rejected with the bare validation error, as if the earlier writes had rolled back, and a sync client didn't announce them.
