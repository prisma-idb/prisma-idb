# ADR 005: No `async`/`await` inside IDB transactions

- **Status:** Accepted
- **Date:** 2026-05-24
- **Area:** Driver

## Summary

The driver chains IndexedDB requests with callbacks: each request is issued from inside the previous request's `onsuccess` handler. It never uses `await` while a transaction is open. Awaiting anything that isn't an IndexedDB request lets the browser commit the transaction early, and the next request then fails.

## Context

IndexedDB's API is event-based. A call such as `store.get(key)` returns an `IDBRequest`, and the result arrives later in its `onsuccess` or `onerror` handler.

A transaction commits automatically when two things are true:

- It has no pending requests.
- The current task has finished and the microtask queue is empty.

`await` resumes your code in a later microtask. If you `await` a promise that isn't waiting on an IndexedDB request, the queue can empty while you wait. The browser then commits the transaction. When your code resumes and issues its next request, the browser throws `TransactionInactiveError`, or `InvalidStateError` if the transaction has already finished.

This behaviour comes from the IndexedDB specification, not from any one browser. Because it depends on timing, the failure is intermittent. It often passes in tests and fails in production under load.

## Decision

While a transaction is open, the driver issues every request synchronously from a callback:

- No handler (`onsuccess`, `onerror`, `oncomplete`) is `async`, and none contains an `await`.
- A multi-step operation issues its next request inside the previous request's `onsuccess`. For example, `execUpdate` reads a record, merges the patch, and writes it back.
- A batch plan runs its operations one after another through `runOpsSequentially`, which starts each operation from the previous one's completion callback.
- `executeIdbPlan` wraps the whole transaction in a promise that resolves in `tx.oncomplete`. This is safe, because by then the transaction has finished and no more requests will be issued.

### Correct: the next request starts inside `onsuccess`

This is `execUpdate` from `execute/ops.ts`, simplified:

```ts
function execUpdate(store: IDBObjectStore, plan: IdbUpdatePlan, onComplete, onError) {
  const getReq = store.get(plan.key);
  getReq.onsuccess = () => {
    const existing = getReq.result;
    if (!existing) {
      onComplete([]);
      return;
    }
    const merged = { ...existing, ...plan.patch };
    const putReq = store.put(merged); // issued synchronously, inside onsuccess
    putReq.onsuccess = () => onComplete([merged]);
    putReq.onerror = () => onError(putReq.error);
  };
  getReq.onerror = () => onError(getReq.error);
}
```

### Wrong: an `await` between two requests

```ts
getReq.onsuccess = async () => {
  const merged = { ...getReq.result, ...plan.patch };
  await someHelperFunction(); // the transaction can commit here
  store.put(merged); // throws: the transaction is no longer active
};
```

### Operations that look like they need `await`

- **Sorted cursor scans.** `execCursorScan` must see every row before it can sort. Each `onsuccess` stores the row and calls `cursor.continue()` synchronously. When the cursor is exhausted, the last `onsuccess` sorts the collected rows. Sorting is synchronous, so no `await` is needed.
- **Batches across several stores.** `executeBatchPlan` opens one transaction for all the stores and runs the operations through `runOpsSequentially`, as described above.

## Alternatives considered

- **`async`/`await` inside the transaction.** Easier to read, but unsafe for the reasons in Context. Rejected.

## Consequences

- Multi-step operations are more verbose than their `async` equivalents would be.
- A new operation type must follow the callback pattern in `execute/ops.ts`.
- Nothing in the type system enforces this rule. Code review has to.
- `fake-indexeddb`, which the unit tests use, doesn't always reproduce real browser timing. Code that awaits inside a transaction can pass the unit tests and still fail in a browser. The Playwright tests in `apps/prisma-orm-usage` run in real Chromium and WebKit to catch this.
- If a request is issued on a transaction that has already committed, the driver reports an `IdbExecuteError` with the code `TRANSACTION_INACTIVE`, which explains the cause. See [ADR 017](ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md).
- The manual transaction scope in [ADR 007](ADR%20007%20-%20Two%20Transaction%20APIs.md) lets application code `await` between requests. The same rule applies there: only await promises that resolve from IndexedDB requests.

## Related

- `driver-idb/src/core/execute/ops.ts`: every operation follows this pattern.
- `driver-idb/src/core/execute/index.ts`: `executeIdbPlan`, `executeAtomicPlan`, `executeBatchPlan` and `runOpsSequentially`.
- MDN: [Using IndexedDB, transactions](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#using_a_transaction).
