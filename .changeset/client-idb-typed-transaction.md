---
"@prisma-idb/client-idb": minor
---

Add `db.transaction(rootKeys, async (tx) => ...)`, which runs several ORM calls in one IndexedDB transaction. `tx` has the ORM accessors of the listed models only. The transaction commits when the callback resolves and rolls back when it throws. It opens the extra stores that foreign-key checks, cascades and `include` need. If the transaction commits early because the callback awaited a timer or a network call, `IdbTransactionCommittedEarlyError` reports that the earlier writes were saved. `db.withTransaction()` is unchanged.
