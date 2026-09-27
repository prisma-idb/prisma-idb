# ADR 006: Collect rows, then yield them

- **Status:** Accepted
- **Date:** 2026-05-24
- **Area:** Driver

## Summary

The driver reads every result row inside the transaction and only returns them once the transaction has completed. The framework's interface is an `AsyncIterable<Row>`, which suggests streaming, but for IndexedDB it is always backed by an array that is already complete. Streaming would let the transaction commit while the caller waits between rows, and the cursor would then fail.

## Context

The upstream framework returns query results as an `AsyncIterable<Row>`, so a driver can hand out rows one at a time as its cursor moves.

IndexedDB cursors are event-based. Calling `cursor.continue()` makes the next `onsuccess` fire with the next record. A cursor only works while its transaction is active.

## Decision

The driver collects all rows inside the transaction and resolves with the full array in `tx.oncomplete`. That array is then wrapped as an `AsyncIterable`. No row reaches the caller while the transaction is open.

```ts
// Simplified from executeAtomicPlan:
const rows = await new Promise<Row[]>((resolve, reject) => {
  const tx = db.transaction(storeName, "readonly");
  // ... the cursor scan pushes rows into `collected` ...
  tx.oncomplete = () => resolve(collected);
  tx.onerror = () => reject(tx.error);
});
// The transaction has committed; `rows` is complete.
return toAsyncIterable(rows);
```

### Why streaming doesn't work

A cursor stops working as soon as its transaction commits. If the driver handed out rows one at a time and the caller paused between rows, which is normal with an `AsyncIterable`, the transaction would commit during the pause. The next `cursor.continue()` would then throw `TransactionInactiveError`. See [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md).

This is a correctness requirement, not a performance trade-off. IndexedDB has no way to keep a transaction open across an `await` in caller code.

## Alternatives considered

- **Keep the transaction alive while streaming.** Standard IndexedDB doesn't allow it. We don't target non-standard implementations that might. Rejected.
- **Read in chunks, with a new transaction per chunk.** For example, read 100 rows, close the transaction, hand them out, then open a new transaction for the next 100. This would support large results, but each chunk could see different data if a write happens in between. Not implemented. It would need explicit, opt-in pagination semantics.
- **Stream from a Web Worker.** Walking the cursor in a worker and streaming rows through a `ReadableStream` would allow real streaming, but it means sending IndexedDB requests across a `MessageChannel`. Out of scope.

## Consequences

### Memory and latency

- **Memory.** All matching rows are in memory at once. On a store with 100,000 records, `all()` is expensive. IndexedDB is meant for moderately sized client-side data. For large stores, page through results with `skip()` and `take()`.
- **Latency.** The caller gets the first row only after the last one has been read. For local storage the scan is fast, so this is acceptable.

### Sorting and pagination

- **With an `orderBy`:** the driver collects every matching row, sorts them, then applies `skip` and `take`.
- **Without an `orderBy`:** the driver applies `skip` and `take` while the cursor moves, and stops the cursor as soon as it has `take` rows.

### Middleware

The framework's middleware runner calls the `onRow` hook inside a `for await` loop over the driver's rows. For SQL and Mongo drivers those rows come from a live cursor. So a middleware that stops early, or aborts with an `AbortSignal`, really does stop further database work.

For IndexedDB, all rows are already in memory before `onRow` is first called. As a result:

- **Stopping early in `onRow` doesn't reduce reads.** The scan has already finished.
- **Aborting doesn't stop the scan.** The remaining rows have already been read. They just haven't been handed to the caller yet.
- **Observing still works.** Logging, metrics and cache population behave correctly. They just see rows from a finished scan.

To limit how many rows are read, use `take()` on the query, not an early exit in `onRow`:

```ts
// Limits the scan itself: the cursor stops after 100 rows.
const rows = await db.users.take(100).all().toArray();
```

The framework's `RuntimeMiddleware` type says `onRow` fires "per row as the driver yields". Our implementation meets that: it fires once per row, in order. It just doesn't stream. Middleware written for backpressure won't work on IndexedDB and should say so. The `IdbMiddleware` type in `runtime-idb/src/idb-middleware.ts` documents this limitation.

## Related

- `driver-idb/src/core/execute/index.ts`: `executeAtomicPlan`.
- `driver-idb/src/core/execute/ops.ts`: `execCursorScan`, the collection loop.
- `runtime-idb/src/idb-middleware.ts`: `IdbMiddleware` and its `onRow` note.
