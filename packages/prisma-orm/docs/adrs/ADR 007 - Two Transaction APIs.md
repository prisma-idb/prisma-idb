# ADR 007 — Two Transaction APIs: Automatic Store Inference vs. Manual Scope

## Context

IDB transactions are scoped to a fixed list of object stores declared at open time (`db.transaction(["users", "posts"], "readwrite")`). You cannot add more stores to an in-progress transaction. All read and write requests must be issued against stores that were named when the transaction was opened.

Phase 6.4 (nested relation writes) requires writing to multiple stores atomically. For example, `db.users.create({ posts: (rel) => rel.create([...]) })` must write to `users` and `posts` in the same transaction. Phase 6.3 (multi-store transaction support) also enables user-authored multi-store operations.

The question is: who decides which stores a transaction spans?

## Decision

Provide two distinct APIs with different contracts:

### API 1 — Automatic inference (for nested writes from the ORM)

When the ORM layer detects relation callbacks in a `create()` or `update()` call, it walks the contract's relation graph to collect all stores transitively involved, then opens a single transaction spanning all of them via `withMutationScope()`. The user never names stores.

```ts
// User writes:
await db.users.create({
  id: "u1",
  name: "Alice",
  posts: (rel) => rel.create([{ title: "Post 1" }, { title: "Post 2" }]),
});
// Internally: store names ["users", "posts"] derived from contract's relation graph
// before the transaction is opened.
```

**When this is possible:** The stores involved in nested writes are known at parse time — `parseMutationInput()` walks `data` to identify which fields are relation callbacks and reads the contract to find their target stores. All stores are collected before the transaction opens.

**Limitation:** The store list must be fully known before any IDB request is issued. `parseMutationInput()` + `partitionByOwnership()` do this synchronously from the contract, so no pre-flight IDB access is needed.

### API 2 — Manual scope (for application-controlled atomicity)

When the user wants to write to multiple stores in ways that are not expressible as a single nested write (e.g. conditional logic, two independent model writes, or operations the ORM doesn't model), they call `db.transaction()` explicitly and name the stores upfront.

```ts
await db.transaction(["users", "posts"], async (tx) => {
  const user = await tx.users.create({ name: "Alice" });
  if (user.role === "author") {
    await tx.posts.create({ authorId: user.id, title: "First Post" });
  }
});
```

**Why the user must name stores upfront:** Inside the `run` callback, application code may conditionally access different stores based on runtime values. There is no static analysis that can determine which stores will be used. The transaction must be opened before the callback runs, so the caller must enumerate stores explicitly.

## Why two APIs and not one

Once the manual API exists, you can no longer infer stores for users — the callback might access stores not derivable from a single ORM call chain. The two APIs have genuinely separate contracts:

- **Automatic inference:** "I'm doing a nested write that the ORM models. You know what stores I need."
- **Manual scope:** "I'm doing something the ORM doesn't model. I'll tell you what stores I need."

Collapsing them into one API would either force all multi-store operations to name stores manually (breaking ergonomics for nested writes) or require static analysis of the callback body (impossible at runtime).

This is the same distinction the older generator used, and it holds for the same reasons.

## Implementation notes

**Automatic path (`withMutationScope` in `client-idb/src/core/mutation-scope.ts`):**

- `parseMutationInput(contract, modelName, data)` splits scalars from relation callbacks
- `partitionByOwnership()` separates parent-owned (N:1) from child-owned (1:N/1:1) relations
- Store names are collected by walking `contract.relations[modelName]` for each relation field found
- `withMutationScope(executor, storeNames, run)` opens the transaction, calls `run(scope)`, commits on success, aborts on error

**Manual path (`IdbTransactionScope` in `driver-idb/src/core/transaction-scope.ts`):**

- `executor.transaction(storeNames, "readwrite")` returns an `IdbTransactionScope`
- The scope exposes `execute(plan)` for individual operations and `commit()` / `rollback()`
- All plans executed through the scope share one underlying IDB transaction

## Consequences

- Nested writes from the ORM (Phase 6.4) are fully automatic — the user declares relations, the ORM handles atomicity.
- Application code that needs multi-store atomicity outside the ORM's model uses `db.transaction()`.
- If a user calls `db.transaction()` for a nested write that the ORM could have handled automatically, that is fine — the manual API is a strict superset.
- The manual API leaks IDB store names into application code. This is intentional: the user is opting into IDB-specific atomicity semantics.

## Related

- `client-idb/src/core/mutation-scope.ts` — `withMutationScope()` implementation (Phase 6.3)
- `driver-idb/src/core/transaction-scope.ts` — `IdbTransactionScope` interface (Phase 6.3)
- `client-idb/src/core/mutation-executor.ts` — `parseMutationInput`, `partitionByOwnership` (Phase 6.4)
- Upstream `sql-orm-client/mutation-executor.ts` — the SQL ORM pattern we ported from
- [PLAN.md](../../PLAN.md) § Phase 6.3, § Phase 6.4
