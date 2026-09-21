# ADR 006 — Collect-then-Yield: Full Row Materialization Inside the Transaction

## Context

The upstream framework exposes query results as `AsyncIterable<Row>` — a streaming interface. This means the driver can theoretically yield rows incrementally as the cursor advances, rather than buffering all rows before returning.

IDB cursors are event-driven: you call `cursor.continue()` to advance, and the next `onsuccess` fires with the next record. The cursor is alive as long as the transaction is active.

The question is whether the driver should yield rows incrementally (one per cursor advance) or collect all rows inside the transaction and resolve with an array.

## Decision

The driver collects all rows inside the transaction, resolves with a full array on `tx.oncomplete`, and then the outer wrapper converts that array to an `AsyncIterable`. No rows are yielded while the transaction is still open.

```ts
// In executeIdbPlan():
const rows = await new Promise<Row[]>((resolve, reject) => {
  const tx = db.transaction(storeName, "readonly");
  // ... cursor scan collects into `collected: Row[]` ...
  tx.oncomplete = () => resolve(collected);
  tx.onerror = () => reject(tx.error);
});
// rows is now a fully materialized array; transaction is committed
return toAsyncIterable(rows);
```

## Why full materialization is required

**IDB cursors are transaction-scoped.** A cursor becomes invalid the moment its transaction commits. If we yielded rows incrementally and the consumer paused consumption between rows (a common pattern with `AsyncIterable`), the transaction would auto-commit during that pause and subsequent `cursor.continue()` calls would fail with `TransactionInactiveError`.

This is not a performance trade-off — it is a correctness requirement. There is no IDB API to keep a transaction alive across `await` boundaries in user code.

**The streaming abstraction does not reach into the transaction.** The `AsyncIterable<Row>` interface suggests streaming, but for IDB the stream can only begin after the transaction is done. The `AsyncIterable` returned by the driver is backed by an in-memory array, not a live cursor.

## Performance implications

**Memory:** All matching rows for a query are held in memory simultaneously. For queries returning large result sets (e.g. `all()` on a store with 100k records), this is a real cost. IDB is designed for moderately-sized client-side datasets where this is acceptable. If a store grows to a size where full materialization is problematic, the appropriate response is to use cursor-based pagination (`skip`/`take`) rather than consuming unbounded result sets.

**Latency:** The first row is not available to the caller until the last row has been fetched and the transaction committed. For the same reason as above, this is acceptable in the IDB context. The latency is bounded by the cursor scan time, which is fast for local storage.

## What we deliberately did not do

**Keep-alive transactions for streaming:** It is not possible in standard IDB to keep a transaction alive across `await` points in user code. Some environments (e.g. OPFS-based IDB polyfills) may support this, but we do not target non-standard IDB environments.

**Chunked reads with re-opened transactions:** We could read 100 rows, close the transaction, yield them, then open a new transaction for the next 100. This would support large result sets at the cost of consistency — two reads of the same store in different transactions can return different data if a write occurs between them. We do not implement this; it would require explicit opt-in pagination semantics.

**Worker-based streaming:** Offloading the cursor walk to a Web Worker with a `ReadableStream` would allow true streaming, but it would require serializing IDB requests across a MessageChannel, which is significantly more complex. Out of scope.

## Consequences

- `driver-idb`'s `execute()` method returns `AsyncIterable<Row>` for interface compatibility with the framework, but the iterable is always backed by a materialized array.
- `IdbStoreAccessor.all()` materializes all rows. Users should use `take()` and `skip()` for pagination.
- The sort, skip, and take operations in the driver are all post-materialization (sort the array, then slice). This is consistent with the collect-then-yield model.
- Middleware `onRow` hooks in `runtime-idb` fire synchronously over the materialized array, not during cursor traversal. See the section below for the full implications of this.

## Middleware implications

The framework's `run-with-middleware.ts` fires `onRow` inside a `for await` loop over the row source. For SQL and Mongo drivers, that row source is a live cursor: rows arrive one at a time as the cursor advances, so middleware that wants to short-circuit (e.g. stop after collecting N rows, or cancel via `AbortSignal`) genuinely prevents further database work.

**For IDB this invariant does not hold.** When the `for await` loop in `run-with-middleware.ts` starts, the IDB driver has already returned a fully materialized array. All rows are in memory. Consequently:

- **Backpressure is ineffective.** A middleware that returns early from `onRow` (or throws an abort signal) does not reduce the number of rows read from the object store. The cursor scan already ran to completion before `onRow` was called for the first time.
- **`AbortSignal` cannot short-circuit materialization.** Aborting after seeing row N does not prevent rows N+1 … M from having been read; they are already in memory, just not yet yielded to the caller.
- **The `onRow` hook is still useful for observation.** Logging, metrics collection, and read-through cache population all work correctly — they just receive rows from an already-complete scan rather than observing rows as they arrive from the database.

### What this means in practice

Use `take(n)` on the query builder, not `onRow` early-exit, to bound the number of rows materialized:

```ts
// ✅ Correct — bounding happens before IDB reads
const rows = await db.users.take(100).all().toArray();

// ⚠️  Does not reduce IDB reads — onRow fires after all rows are in memory
db.users
  .all()
  .execute()
  .onRow((row, plan, ctx) => {
    if (someCondition) throw new AbortError(); // too late; full scan already ran
  });
```

Middleware that needs to observe IDB query results (cache population, telemetry) should use `afterExecute` with the `rowCount` rather than assuming `onRow` will fire incrementally.

### Why this diverges from the framework contract

The framework's `RuntimeMiddleware` type documents `onRow` as firing "per row as the driver yields". That language assumes a streaming driver. IDB is structurally incapable of being a streaming driver (see "Why full materialization is required" above), so our `onRow` firing pattern is a compliant-but-semantically-different implementation of the same hook. The hook fires once per row and in order — the only difference is that all rows have been read before any of them are delivered to `onRow`.

This divergence is harmless for all middleware written today. It becomes observable if someone writes middleware that depends on `onRow` to apply backpressure. Any such middleware must document that it does not apply to IDB targets.

## Related

- `driver-idb/src/core/execute/index.ts` — `executeAtomicPlan` implementation
- `driver-idb/src/core/execute/ops.ts` — `execCursorScan` cursor collection loop
- `runtime-idb/src/idb-middleware.ts` — `IdbMiddleware` type with onRow warning
- [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md) — why we can't yield inside the transaction (the async/await constraint is what makes streaming impossible)
