# ADR 007: Two transaction APIs

- **Status:** Accepted. The manual API has a typed form, `db.transaction()`, and a low-level form, `db.withTransaction()`.
- **Date:** 2026-05-24
- **Area:** ORM

## Summary

There are two ways to get a transaction that spans several object stores:

- **Automatic**, for nested writes. The ORM works out which stores a nested write touches from the contract, and opens one transaction over all of them.
- **Manual**, for everything else. The caller names the stores up front, because the ORM can't predict what arbitrary application code will touch.

## Context

An IndexedDB transaction covers a fixed list of object stores, named when it opens: `db.transaction(["users", "posts"], "readwrite")`. You can't add a store to a transaction that is already running.

Some operations must write to several stores atomically. For example, `db.orm.users.create({ posts: (rel) => rel.create([...]) })` must write to `users` and `posts` in one transaction. Applications also need their own multi-store operations. So something has to decide which stores a transaction covers before it opens.

## Decision

### Automatic: nested writes from the ORM

When a `create()` or `update()` call includes relation callbacks, the ORM collects every store the write touches by following the relations in the contract. It then opens one transaction over all of them with `withMutationScope()`. The user never names a store.

```ts
await db.orm.users.create({
  id: "u1",
  name: "Alice",
  posts: (rel) => rel.create([{ title: "Post 1" }, { title: "Post 2" }]),
});
// The ORM derives ["users", "posts"] from the contract before opening the transaction.
```

This works because the stores are known before any request is issued. `parseMutationInput()` separates plain fields from relation callbacks, and `partitionByOwnership()` sorts the relations. Both work from the contract alone, without touching IndexedDB.

### Manual: application-controlled transactions

Some multi-store work doesn't fit a single nested write: conditional logic, two unrelated model writes, or operations the ORM doesn't model. For these, the caller names the stores explicitly.

The typed API gives the callback ORM accessors for the models it names:

```ts
await db.transaction(["users", "posts"], async (tx) => {
  const user = await tx.users.create({ id: "u1", name: "Alice" });
  if (user.name === "Alice") {
    await tx.posts.create({ id: "p1", authorId: user.id, title: "First Post" });
  }
});
```

The first argument lists root keys. `tx` is typed as the ORM client restricted to those keys, so a model you did not list is a compile error. The transaction commits when the callback resolves and rolls back when it throws.

`db.transaction()` builds an executor bound to the open transaction and passes it to `idbOrm()`. Every accessor operation then runs on that one transaction:

- A plain read or write runs its plan on the open transaction instead of opening a new one.
- An operation that opens its own mutation scope, such as an FK-checked create or a cascade delete, receives a view of the open transaction. `commit()` on the view does nothing, so only the outer call commits. `rollback()` aborts the whole transaction.
- A failed operation aborts the whole transaction, even if the callback catches the error. A half-applied write cannot be told apart from a clean validation failure, so the transaction does not continue.

The caller lists models, not stores. The transaction also opens the stores those models need: related models for FK checks and `include`, and the cascade graph for deletes (`collectDeleteStoreNames`). An operation that needs any other store fails with an error that names it.

Sync tracking needs no extra code. The sync client builds the transaction on its sync executor, so the scope is the `SyncInterceptingTransactionScope`. It records an outbox event for each tracked write in the same transaction, and notifies `outboxwrite` listeners once after the commit. `SyncIdbClient.withTransaction()` runs on the raw runtime and records nothing.

The lower-level form is `db.withTransaction(storeNames, fn)`. It passes `fn` an `IdbTransactionScope`, which runs driver plans with `scope.execute(plan)`. It commits when `fn` resolves and rolls back when `fn` throws. The sync extension uses it to apply pulled changes.

The caller must name the models because the callback can decide at runtime which stores to use. No analysis can find that out ahead of time, and the transaction must be open before the callback runs.

## Why two APIs, not one

The two APIs make different promises:

- **Automatic:** "This is a nested write the ORM models. You know which stores it needs."
- **Manual:** "This is something the ORM doesn't model. I'll tell you which stores it needs."

A single API would either make every nested write list its stores by hand, which is worse to use, or need to analyse the callback's code at runtime, which isn't possible. The older generator made the same split for the same reasons.

## Consequences

- Nested writes are atomic with no extra work from the user.
- Multi-store work that the ORM doesn't model uses the manual API.
- Using the manual API for something the ORM could do automatically is fine. The manual API can do everything the automatic one can.
- The manual API exposes store names to application code. This is deliberate: the caller is opting into IndexedDB's transaction rules.
- Inside a manual transaction, the caller must only `await` promises that resolve from IndexedDB requests. Awaiting anything else, such as `fetch` or a timer, lets the transaction commit early ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)). JavaScript cannot forbid this, so the typed API surfaces it in three ways:
  - A request on a transaction that already finished fails with the driver's `TRANSACTION_INACTIVE` error.
  - Early commit breaks atomicity silently: a later throw cannot roll back writes that are already saved. When the callback throws, or an operation fails, after the transaction finished on its own, `db.transaction()` throws `IdbTransactionCommittedEarlyError`. Its message says the earlier writes were saved, and `cause` holds the original error.
  - The public docs and the TSDoc on `transaction()` state the rule.
- Calling `db.transaction()` from inside a callback opens a second, separate transaction. Awaiting it is awaiting other work, so the outer transaction commits early and its next operation fails as above. The docs tell users not to nest.

## Related

- `client-idb/src/core/mutation-scope.ts`: `withMutationScope()`.
- `client-idb/src/core/mutation-executor.ts`: `parseMutationInput()`, `partitionByOwnership()`.
- `client-idb/src/core/idb-client.ts`: `transaction()` and `withTransaction()`.
- `client-idb/src/core/orm-transaction.ts`: `runOrmTransaction()`, `IdbTransactionCommittedEarlyError`.
- `client-idb/src/core/open-transaction.ts`: the executor bound to the open transaction.
- `driver-idb/src/core/transaction-scope.ts`: `IdbTransactionScope`.
