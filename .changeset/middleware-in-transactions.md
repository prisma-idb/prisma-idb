---
"@prisma-idb/runtime-idb": minor
"@prisma-idb/client-idb": minor
---

Middleware now observes statements inside transactions: `db.transaction()`, and the scoped reads and writes of nested, cascading and foreign-key-checked mutations. Before, those statements bypassed middleware, so a cache was never told about a transactional write.

- The transaction is an activity with `ctx.scope === "transaction"`, and each statement is an activity beneath it.
- Statement hooks (`activityStarted`, `beforeEncode`, `onRow`, `activityEnded`) are called but not awaited, because IndexedDB commits a transaction that waits. A synchronous throw from `activityStarted` or `beforeEncode` blocks the statement, as upstream's does, and the transaction rolls back. Other hook errors and rejected hook promises are logged to `ctx.log` as `{ event, middleware, error }` instead of failing the statement. An async `beforeEncode` gets one `IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION` warning per client.
- `onRow` runs for statements that return rows, not for writes.
- `intercept` hooks are skipped inside transactions.
- Once IndexedDB commits or aborts, every statement and the transaction get `activityFinalized` with `committed`, `rolled-back` or `unknown`. `commit()` settles after those hooks, also when it rejects, so cache invalidation finishes before the caller continues. A transaction hook that throws after IndexedDB has committed is logged and does not fail `commit()`; upstream would rethrow it. A hook error before the transaction opens, from the transaction's `activityStarted`, still rejects.
- Without a `ctx` passed to `createIdbRuntime`, which the client factories never pass, `ctx.log.warn` and `ctx.log.error` now write to the console. Upstream's default logger is a no-op. Behavior change: a middleware's `ctx.log.warn` and `ctx.log.error` calls, which were silent, now print.

`createAutoMigratingIdbClient` now accepts `middleware`, like `createIdbClient`.
