# ADR 004 — Driver Isolation via IdbRowFilter Closure Boundary

## Context

The driver (`driver-idb`) is the lowest-level package — it opens IDB connections, executes plans, and yields rows. It has no opinion about queries. Above it, the adapter (`adapter-idb`) owns the filter expression AST (`IdbFilterExpr`) and the evaluation logic (`evaluateFilter()`).

When the ORM layer builds a cursor-scan plan that includes a filter (e.g. `where({ active: true })`), the filter must get from the ORM down to the driver's cursor loop. There are two ways to do this:

1. **Pass the AST:** The `IdbCursorScanPlan` carries `filter?: IdbFilterExpr`. The driver imports `evaluateFilter` from `adapter-idb` to interpret it.
2. **Pass a closure:** The `IdbCursorScanPlan` carries `filter?: IdbRowFilter` where `IdbRowFilter = (row: Record<string, unknown>) => boolean`. The adapter builds the closure before the plan reaches the driver.

## Decision

Use the closure boundary. The driver's plan type carries `filter?: IdbRowFilter` — an opaque predicate function. `adapter-idb` builds the closure by calling `evaluateFilter(expr, row)` when the plan is being assembled. The driver never imports anything from `adapter-idb`.

```ts
// In adapter-idb (plan assembly):
const filter: IdbRowFilter = expr ? (row) => evaluateFilter(expr, row) : undefined;
const plan: IdbCursorScanPlan = { kind: 'cursor-scan', storeName, filter, ... };

// In driver-idb (cursor execution):
if (plan.filter && !plan.filter(row)) continue; // driver has no idea what IdbFilterExpr is
```

## Why the closure boundary is correct

**Package dependency direction.** The established dependency graph is:

```
driver-idb → (nothing in this family)
adapter-idb → target-idb
runtime-idb → adapter-idb, driver-idb
client-idb → target-idb, adapter-idb, driver-idb
```

If the driver imported `evaluateFilter` from `adapter-idb`, the dependency direction would be reversed: `driver-idb → adapter-idb`. This would couple the lowest-level executor to the query layer, making it impossible to use the driver without the full adapter stack.

**The driver's contract is execution, not interpretation.** The driver's job is: open a transaction, walk a cursor, apply a predicate, yield rows. It does not need to know whether that predicate came from a filter expression, a stored query, a hardcoded lambda, or anything else. The predicate is a black box to the driver.

**Bundle boundary.** In a future where the driver is distributed as a smaller, standalone package (e.g. for use with a different query layer or in a service worker), the absence of `adapter-idb` as a dependency keeps the driver's bundle minimal.

**Serialization boundary (secondary benefit).** Functions in JavaScript are not serializable — `JSON.stringify`, `structuredClone`, and `postMessage` all reject them. `IdbFilterExpr` is a plain frozen object and would be serializable. By keeping `filter` as a function on the plan, the plan is intentionally non-serializable. This makes it visible in the type system that plans are ephemeral, execution-local objects that are not meant to be transmitted over a `MessageChannel`, stored in `localStorage`, or sent to a Web Worker without an explicit serialization protocol.

## What we deliberately did not do

**Putting `IdbFilterExpr` in `IdbCursorScanPlan`:** Both approaches put a filter field in the plan — the difference is whose type appears there. `IdbCursorScanPlan` lives in `driver-idb`. If it declared `filter?: IdbFilterExpr`, `driver-idb` would need to import `IdbFilterExpr` from `adapter-idb` just to write the type, creating a `driver-idb → adapter-idb` dependency. `IdbRowFilter` is defined in `driver-idb` itself (`(row: Record<string, unknown>) => boolean`) — no import needed. The closure is the mechanism that lets the adapter's evaluation logic travel downward without the adapter's type crossing the package boundary with it.

**Putting `evaluateFilter` in a shared package:** We considered moving filter evaluation to a package between driver and adapter so both could import it. This creates a new package dependency just to avoid a closure, which is more complexity than the closure introduces.

## Consequences

- `driver-idb` has zero dependencies on `adapter-idb`. This is verified by the package dependency graph.
- The sort comparator follows the same pattern: `IdbRowComparator = (a, b) => number`. The driver applies it with `rows.sort(plan.comparator)` without knowing how the comparator was built.
- Testing the driver in isolation is straightforward — pass arbitrary `IdbRowFilter` lambdas without needing to build `IdbFilterExpr` nodes.

## Related

- `driver-idb/src/core/plan-body.ts` — `IdbRowFilter` and `IdbRowComparator` type definitions
- `adapter-idb/src/core/idb-adapter.ts` — where the closure is built during `lower()`
- [ADR 003](ADR%20003%20-%20Plain%20Frozen%20Objects%20for%20Filter%20AST.md) — the filter expression AST design
