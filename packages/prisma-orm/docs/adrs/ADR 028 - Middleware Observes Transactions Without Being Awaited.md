# ADR 028: Middleware observes transactions without being awaited

- **Status:** Accepted
- **Date:** 2026-11-22
- **Area:** Runtime and middleware

## Decision

Statements inside an IndexedDB transaction run as middleware activities beneath a transaction activity, as in upstream runtimes. This covers `db.transaction()` and the scoped reads and writes of nested, cascading and foreign-key-checked mutations. Middleware hooks for those statements are called but not awaited:

- The transaction starts through the framework's `startTransactionActivity` before IndexedDB opens it, so its `activityStarted` hooks are awaited. Its context has `scope: "transaction"`.
- Each statement's `activityStarted`, `beforeEncode`, `onRow` and `activityEnded` hooks are called and not awaited. Only their synchronous part runs before the next request. A synchronous throw from `activityStarted` or `beforeEncode` blocks the statement, as upstream's "Throw to block the statement": the statement fails with that error before it reaches IndexedDB, so the caller's rollback aborts the transaction. A promise they return that rejects is logged, since the statement has already run by then. An error from `onRow` or `activityEnded` is logged, and the statement continues. An async `beforeEncode` gets one warning per middleware and client (`IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION`), since a change it makes after an `await` misses the statement.
- `onRow` runs only for statements that return rows. Writes echo the rows they touched, but report them as affected-row stats, as upstream's writes do.
- Statements the client sends for its own bookkeeping, such as its check that a transaction is still active, are marked with `withoutMiddleware` and run without any hook.
- `intercept` hooks are not consulted inside a transaction.
- When IndexedDB completes or aborts the transaction, it ends through the framework: `activityEnded` for the transaction, then `activityFinalized` for each statement and for the transaction, with `committed`, `rolled-back`, or `unknown` for an abort after `commit()` was called before any `rollback()`. A `commit()` after `rollback()` only waits for the outcome. `commit()` settles after those hooks, whether it resolves or rejects. After a rollback, finalization runs right after the abort and is not awaited by the call that rejected.

## Why

An IndexedDB transaction commits as soon as no request is pending and control returns to the event loop ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)). Upstream awaits each hook, and a hook that awaits real async work, such as a cache store, would commit the transaction early. The remaining writes would then fail with the first ones already saved. Before this decision the runtime avoided that by sending transaction statements straight to the driver. Middleware then never saw them, and a cache was never told that a transactional write landed. Upstream's cache invalidates on `activityFinalized`, so that gap left caches serving stale reads.

Calling hooks without awaiting them keeps the transaction intact and delivers the events upstream delivers for a statement, in the same order, except that work a hook does after an `await` happens after the statement. Intercepts are skipped because a transaction must read its own uncommitted writes; upstream's cache middleware skips transactions for the same reason. `activityFinalized` runs after the transaction has ended, when awaiting is safe, so it is awaited and a cache is invalidated before `commit()` resolves.

## Consequences

- Telemetry and cache middleware see transactional statements and their final outcome.
- A hook inside a transaction cannot delay the statement. It can block it only by throwing synchronously; an asynchronous failure is logged and does not fail it.
- `onRow` inside a transaction runs after the statement's rows were read, as it does outside one ([ADR 006](ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md)).

## Update 2026-11-24: errors and logging

- A hook's error never fails the transaction. Upstream rethrows the first error of a transaction's `activityEnded` hooks after finalizing, so a throwing hook fails the call. IndexedDB has already committed or aborted by the time those hooks run, so rejecting would report a failure for saved data and skip the sync client's `outboxwrite` notification. The runtime logs the error instead, after the framework has finalized every statement and the transaction. An error thrown before the transaction opens, from the transaction's `activityStarted`, still rejects, since nothing has run yet.
- Errors and the async `beforeEncode` warning go to `ctx.log`. Each logged error is `{ event, middleware, error }`: the hook that failed, the name of its middleware, and the error. Errors from the transaction's own `activityEnded` hooks, which the framework reports together, have no `middleware`. When the caller passes no `ctx` to `createIdbRuntime`, which no client factory does, the default logger writes `warn` and `error` to the console and drops `info`. Upstream's default loggers are no-ops. A no-op would discard every error from a hook that cannot fail its statement, so this runtime differs on purpose.

## Rejected alternatives

- **Keep bypassing middleware:** caches stay stale after transactional writes, and telemetry misses those statements.
- **Await hooks inside the transaction:** any hook that awaits real async work commits the transaction early and breaks atomicity.
- **Buffer events and replay them after commit:** hooks would lose their timing inside the transaction, and `beforeEncode` could never apply to a transactional statement.
