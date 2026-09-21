# ADR 005 — Event-Driven Execution: No async/await Inside IDB Transactions

## Context

IDB uses an event-driven, callback-based API. When you call `store.get(key)`, it returns an `IDBRequest`. You attach `onsuccess` and `onerror` handlers to that request. The handler fires synchronously in an IDB "event loop" context.

The `IDBTransaction` has a critical lifecycle rule: **a transaction auto-commits when there are no pending IDB requests AND the event loop returns to the browser**. More precisely, using the microtask semantics of modern JS engines: after the last `onsuccess` or `onerror` handler fires, if the code returns without issuing another IDB request, the transaction will commit when the microtask queue drains.

`async/await` in JavaScript is syntactic sugar over Promises, which resolve via microtasks. An `await` inside an IDB event handler yields execution to the microtask queue, which may drain — and the browser may commit the transaction — before your next line runs.

## Decision

All IDB request issuance inside a live transaction must be synchronous and callback-based, with no `await` between request creation and the next request in a chain. Specifically:

- No `await` inside `onsuccess`, `onerror`, or `oncomplete` handlers.
- Multi-step operations (e.g. `execUpdate`: get → merge → put) chain requests by issuing the next request inside the previous request's `onsuccess`.
- Batch operations chain through recursive `runOpsSequentially()` callbacks.
- The outer `execute()` wrapper wraps the whole transaction in a Promise that resolves on `tx.oncomplete` — this is fine because the Promise resolves after the transaction is already done.

### Correct pattern (from `execute/ops.ts`):

```ts
// execUpdate: get → merge → put, all inside one readwrite transaction
function execUpdate(store: IDBObjectStore, plan: IdbUpdatePlan, onComplete, onError) {
  const getReq = store.get(plan.key);
  getReq.onsuccess = () => {
    const existing = getReq.result;
    if (!existing) {
      onComplete([]);
      return;
    }
    const merged = { ...existing, ...plan.patch };
    const putReq = store.put(merged); // issued SYNCHRONOUSLY inside onsuccess
    putReq.onsuccess = () => onComplete([merged]);
    putReq.onerror = () => onError(putReq.error);
  };
  getReq.onerror = () => onError(getReq.error);
}
```

### Anti-pattern (what we do NOT do):

```ts
// This would silently corrupt transactions
getReq.onsuccess = async () => {
  const existing = getReq.result;
  const merged = { ...existing, ...plan.patch };
  await someHelperFunction(); // ← yields to microtask queue; transaction may auto-commit here
  store.put(merged); // ← IDB request on a committed transaction → InvalidStateError
};
```

## Why this constraint exists

This is an IDB specification requirement, not a browser implementation quirk. The IDB spec states that a transaction's active flag is set to false after the event dispatch that created the request returns. In practice, this means: once an event handler returns without issuing a new request, the transaction is eligible for commit. Awaiting a Promise between requests creates a gap in which the browser is free to commit.

The failure mode is an `InvalidStateError` thrown by IDB when code attempts to use an already-committed transaction. This error is easy to miss in tests (where timing is different) and can be intermittent in production (depends on event loop pressure).

## How we handle operations that appear to need async work

**`execCursorScan` with sorting:** Sorting requires all rows to be collected before any can be returned. We collect all rows synchronously in the cursor's `onsuccess` chain (each advance issues a synchronous `cursor.continue()`), then sort the collected array in the final `onsuccess` when the cursor is exhausted. The sort itself is synchronous.

**`executeBatchPlan`:** Runs multiple ops across multiple stores in one transaction. Uses `runOpsSequentially()` — a recursive callback that issues the next op only when the current op's `onComplete` fires. No `await` anywhere in the chain.

**The outer Promise wrapper:** The `executeIdbPlan()` function wraps the entire transaction in a `Promise<Row[]>` that resolves in `tx.oncomplete`. This is correct because `tx.oncomplete` fires after all requests are done and the transaction has committed — at that point, no more IDB requests will be issued, so yielding to the microtask queue is safe.

## Testing implications

In tests using `fake-indexeddb`, this constraint is less visible because the fake implementation runs synchronously. Tests that pass with `fake-indexeddb` but use `await` inside transaction handlers will silently work in tests and fail intermittently in real browsers. The architecture rule is: if you can't write it without `await` inside a handler, reconsider the approach.

## Consequences

- All multi-step IDB operations are more verbose than their async equivalents.
- Adding new operation types requires following the callback-chaining pattern established in `execute/ops.ts`.
- The constraint is enforced by convention and code review, not by the type system.

## Related

- `driver-idb/src/core/execute/ops.ts` — all operation implementations follow this pattern
- `driver-idb/src/core/execute/index.ts` — `executeBatchPlan` and `executeAtomicPlan` wrappers
- MDN: [Using IndexedDB — transactions](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#using_a_transaction) — "A transaction has a fixed scope that you specify when you create the transaction."
