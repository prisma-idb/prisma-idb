---
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

`db.transaction()` confirms that IndexedDB committed before reporting `IdbTransactionCommittedEarlyError`. If validation fails after an early commit, the error retains the validation failure as its cause even if the callback caught it. The runner waits on the transaction scope's commit once, so commit hooks run once.

The sync client emits `outboxwrite` for tracked writes that persisted before a later failure. Both raw transaction APIs also emit `outboxchange` when `markSynced` or `markFailed` commits before the callback throws.
