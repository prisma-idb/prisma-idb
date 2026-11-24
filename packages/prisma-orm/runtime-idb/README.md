# `@prisma-idb/runtime-idb`

The IndexedDB runtime for Prisma 8. It connects the adapter and driver, runs middleware, and checks that the database matches the contract.

You don't install it yourself; `@prisma-idb/client-idb` depends on it. Import `createIdbRuntime` from `@prisma-idb/runtime-idb/runtime` only if you're building your own client.

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## Cache identity

The built-in middleware context provides `contentHash(plan)`. It returns a SHA-512 digest that middleware can use directly as a cache key. Cache middleware remains responsible for invalidation when stored data changes.

For structured queries, the adapter carries canonical filter values and comparator specifications into the lowered plan's `queryIdentity`. Plans with matching structured closure identities and driver fields produce equal hashes, even when their closures are newly created. Different captured filter values, sort directions, or sort field priorities produce different hashes. Range-split batches retain the same identity for their child scans. The hash also includes the storage hash and driver operation fields, including key-range bounds and open flags.

A raw closure without a corresponding structured identity gets a fresh nonce on every `contentHash` call. Repeated calls produce different hashes, even for the same function reference. This prevents stale cache hits when captured state changes. Function source text is never used as identity. Structured values unsupported by the canonical serializer also use this policy.

Middleware that populates a cache in a later hook should compute the hash once per operation and retain it in `ctx.state(key)`, which holds one object per statement. Custom context overrides supply their own `contentHash` implementation and must preserve these correctness guarantees.

## Middleware inside transactions

Statements inside a transaction, from `db.transaction()` or from a nested, cascading or foreign-key-checked write, run as activities beneath a transaction activity with `ctx.scope === "transaction"`. IndexedDB commits a transaction that waits, so their `activityStarted`, `beforeEncode`, `onRow` and `activityEnded` hooks are called but not awaited. A synchronous throw from `activityStarted` or `beforeEncode` blocks the statement, and the caller's rollback aborts the transaction; any other hook error is logged instead of failing the statement. `onRow` runs only for statements that return rows. `intercept` hooks are not consulted, so a cache never serves a read inside a transaction. When the transaction completes or aborts, each statement and then the transaction get `activityFinalized` with `committed`, `rolled-back` or `unknown`, and `commit()` settles after those hooks.

Any other hook error in a transaction is logged to `ctx.log` as `{ event, middleware, error }` and never fails the statement or the transaction, because the statement has already run, or IndexedDB has already committed or aborted, when it happens. An error from the transaction's own `activityStarted` rejects, before IndexedDB opens the transaction. When you don't pass `ctx` to `createIdbRuntime`, the default logger writes `warn` and `error` to the console and drops `info`. An `async` `beforeEncode` inside a transaction logs one `IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION` warning per middleware and client.

## License

MIT
