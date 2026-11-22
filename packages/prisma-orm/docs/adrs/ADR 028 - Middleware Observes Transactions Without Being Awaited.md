# ADR 028: Middleware observes transactions without being awaited

- **Status:** Accepted
- **Date:** 2026-11-22
- **Area:** Runtime and middleware

## Decision

Statements inside an IndexedDB transaction run as middleware activities beneath a transaction activity, as in upstream runtimes. This covers `db.transaction()` and the scoped reads and writes of nested, cascading and foreign-key-checked mutations. Middleware hooks for those statements are called but not awaited:

- The transaction starts through the framework's `startTransactionActivity` before IndexedDB opens it, so its `activityStarted` hooks are awaited. Its context has `scope: "transaction"`.
- Each statement's `activityStarted`, `beforeEncode`, `onRow` and `activityEnded` hooks are called and not awaited. Only their synchronous part runs before the next request. An error they throw or reject with is logged, and the statement continues. An async `beforeEncode` gets one warning per middleware (`IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION`), since a change it makes after an `await` misses the statement.
- `intercept` hooks are not consulted inside a transaction.
- When IndexedDB completes or aborts the transaction, it ends through the framework: `activityEnded` for the transaction, then `activityFinalized` for each statement and for the transaction, with `committed`, `rolled-back`, or `unknown` for an abort after `commit()` was called. `commit()` resolves after those hooks. After a rollback, finalization runs right after the abort and is not awaited by the call that rejected.

## Why

An IndexedDB transaction commits as soon as no request is pending and control returns to the event loop ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)). Upstream awaits each hook, and a hook that awaits real async work, such as a cache store, would commit the transaction early. The remaining writes would then fail with the first ones already saved. Before this decision the runtime avoided that by sending transaction statements straight to the driver. Middleware then never saw them, and a cache was never told that a transactional write landed. Upstream's cache invalidates on `activityFinalized`, so that gap left caches serving stale reads.

Calling hooks without awaiting them keeps the transaction intact and still delivers every event upstream delivers, in the same order. Intercepts are skipped because a transaction must read its own uncommitted writes; upstream's cache middleware skips transactions for the same reason. `activityFinalized` runs after the transaction has ended, when awaiting is safe, so it is awaited and a cache is invalidated before `commit()` resolves.

## Consequences

- Telemetry and cache middleware see transactional statements and their final outcome.
- A hook inside a transaction cannot delay or block the statement, and its errors do not fail it. Middleware that must block a statement can do so only outside transactions.
- `onRow` inside a transaction runs after the statement's rows were read, as it does outside one ([ADR 006](ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md)).

## Rejected alternatives

- **Keep bypassing middleware:** caches stay stale after transactional writes, and telemetry misses those statements.
- **Await hooks inside the transaction:** any hook that awaits real async work commits the transaction early and breaks atomicity.
- **Buffer events and replay them after commit:** hooks would lose their timing inside the transaction, and `beforeEncode` could never apply to a transactional statement.
