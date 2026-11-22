---
"@prisma-idb/runtime-idb": minor
"@prisma-idb/client-idb": minor
---

Middleware now observes statements inside transactions: `db.transaction()`, and the scoped reads and writes of nested, cascading and foreign-key-checked mutations. Before, those statements bypassed middleware, so a cache was never told about a transactional write.

- The transaction is an activity with `ctx.scope === "transaction"`, and each statement is an activity beneath it.
- Statement hooks (`activityStarted`, `beforeEncode`, `onRow`, `activityEnded`) are called but not awaited, because IndexedDB commits a transaction that waits. A hook's error is logged instead of failing the statement. An async `beforeEncode` gets a one-time `IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION` warning.
- `intercept` hooks are skipped inside transactions.
- Once IndexedDB commits or aborts, every statement and the transaction get `activityFinalized` with `committed`, `rolled-back` or `unknown`. `commit()` resolves after those hooks, so cache invalidation finishes before the caller continues.

`createAutoMigratingIdbClient` now accepts `middleware`, like `createIdbClient`.
