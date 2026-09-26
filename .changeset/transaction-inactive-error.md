---
"@prisma-idb/driver-idb": patch
---

A request issued on a transaction that has already auto-committed (typically an `await` on something that isn't an IndexedDB request between two operations, see ADR 005/007) now fails with an `IdbExecuteError` coded `TRANSACTION_INACTIVE` and a message explaining the rule, instead of surfacing a bare `TransactionInactiveError`/`InvalidStateError` DOMException. The original exception is kept as `cause`. `IdbTransactionScope.execute()` no longer reports a finished transaction as `STORE_NOT_FOUND`, and an unrecognized plan kind (for example from a stale `driver-idb` build) now rejects with an error instead of never settling.
