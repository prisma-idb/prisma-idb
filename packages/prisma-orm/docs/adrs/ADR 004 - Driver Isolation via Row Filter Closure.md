# ADR 004: Driver isolation via a row-filter function

- **Status:** Accepted
- **Date:** 2026-05-24
- **Area:** Package boundaries

## Summary

A cursor-scan plan carries its filter as a plain function, `IdbRowFilter = (row) => boolean`, rather than as a filter expression. The ORM builds that function from the filter expression before the plan reaches the driver. So `driver-idb` never imports the query layer, and it has no dependencies on the other IndexedDB packages.

## Context

`driver-idb` is the lowest-level package. It opens connections, runs plans and returns rows. It has no knowledge of queries. The filter expression type (`IdbFilterExpr`) and `evaluateFilter()` live higher up, in `adapter-idb` ([ADR 003](ADR%20003%20-%20Plain%20Frozen%20Objects%20for%20Filter%20AST.md)).

When the ORM builds a cursor scan with a filter, such as `where({ active: true })`, the filter has to reach the driver's cursor loop. There are two options:

1. **Pass the expression.** The plan carries `filter?: IdbFilterExpr`, and the driver imports `evaluateFilter` to run it.
2. **Pass a function.** The plan carries `filter?: IdbRowFilter`, a function built before the plan reaches the driver.

## Decision

Pass a function. `IdbRowFilter` is defined in `driver-idb` itself, so the driver needs no imports to describe it. `client-idb` wraps the filter expression in a function when it builds the plan:

```ts
// client-idb, when building the plan:
const filter = expr ? (row) => evaluateFilter(expr, row) : undefined;
const plan: IdbCursorScanPlan = { kind: "cursor-scan", storeName, filter /* ... */ };

// driver-idb, in the cursor loop. It doesn't know what an IdbFilterExpr is:
if (plan.filter && !plan.filter(row)) continue;
```

### Why

- **Dependencies point one way.** The IndexedDB packages depend on each other like this:

  ```
  driver-idb  → (no IndexedDB packages)
  target-idb  → (no IndexedDB packages)
  adapter-idb → driver-idb, target-idb
  runtime-idb → adapter-idb, driver-idb
  client-idb  → adapter-idb, driver-idb, runtime-idb, target-idb
  ```

  If the driver imported `evaluateFilter`, it would depend on `adapter-idb`, which already depends on the driver. The lowest layer would then be tied to the query layer.

- **The driver runs predicates. It doesn't interpret them.** Its job is to open a transaction, walk a cursor, apply a predicate and return rows. Where the predicate came from doesn't matter to it.
- **A smaller driver.** The driver could later be used on its own, for example with a different query layer or in a service worker, without pulling in the adapter.
- **Plans are visibly local.** Functions can't be serialized: `JSON.stringify`, `structuredClone` and `postMessage` all reject them. A plan holding a function is clearly meant to run where it was built, not to be sent to a worker or stored.

## Alternatives considered

- **Put `IdbFilterExpr` in the plan type.** `IdbCursorScanPlan` is defined in `driver-idb`, so the driver would have to import the expression type from `adapter-idb`. That creates the dependency this ADR avoids. Rejected.
- **Move `evaluateFilter` into a new shared package** that both the driver and the adapter could import. That adds a package just to avoid passing a function. Rejected.

## Consequences

- `driver-idb` has no dependencies on the other IndexedDB packages, as its `package.json` shows.
- Sorting works the same way: `IdbRowComparator = (a, b) => number`. The driver calls `rows.sort(plan.comparator)` without knowing how the comparator was built.
- Driver tests can pass any function as a filter, with no need to build filter expressions.
- A plan can't be logged or inspected as data. To see what a plan filters on, look at the query AST that travels alongside it (`IdbQueryPlan.ast`).

## Related

- `driver-idb/src/core/plan-body.ts`: `IdbRowFilter` and `IdbRowComparator`.
- `client-idb/src/core/store-accessor.ts`: where most filter functions are built.
