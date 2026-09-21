# ADR 003 — Plain Frozen Objects for Filter AST

## Context

The upstream framework (SQL ORM lane, Mongo ORM lane) uses class-based frozen AST nodes for query expression trees, following the three-layer polymorphic IR pattern: framework interface → family abstract base → target concrete class. Each node has a constructor that calls `freezeNode(this)`, and lowering is done via visitor dispatch (switch on `node.kind` or a method override).

We need a filter expression AST for the IDB ORM (`IdbFilterExpr`) that supports:

- Scalar comparisons: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `in`, `notIn`
- String ops: `contains`, `startsWith`, `endsWith`
- Boolean combinators: `and`, `or`, `not`
- Null checks: `isNull`, `isNotNull`

The question is whether to follow the class-based IR pattern or use a simpler representation.

## Decision

Use plain frozen objects with a discriminated union (`kind` field) instead of class-based nodes.

```ts
// Produced by factory helpers like fieldFilter(), andExpr(), orExpr()
Object.freeze({ kind: 'field', field: 'name', op: 'contains', value: 'Alice' })
Object.freeze({ kind: 'and', exprs: Object.freeze([...]) })
```

Evaluation is a single recursive function `evaluateFilter(expr, row)` rather than a visitor.

### Why this is right for IDB

**No codec trait-gating.** The SQL ORM gates certain operators by codec traits — for example, `gt`/`lt` are only available on fields with the `numeric` or `order` trait. This is because SQL lowering needs to know whether to emit `>` or `ARRAY_CONTAINS >` or something else depending on the column type. IDB stores native JS values, so the comparison is always `<`/`>`/`<=`/`>=` on the raw field value. There are no traits to gate on. Every operator is available on every field.

**Evaluation is in-memory JS, not compilation.** The SQL filter AST is compiled to SQL; visitor dispatch is the natural shape for a compiler. IDB filter evaluation is a recursive JS function that reads `row[field]` and applies JS operators. A `switch(expr.kind)` inside one function is simpler and more readable than a class hierarchy with overridden methods.

**JSON-serializable by default.** Plain frozen objects serialize to JSON without any custom `toJSON()` methods or external serializers. This matters for Phase 7 (outbox sync): the outbox needs to transmit filter expressions to the server so it knows which rows the client is tracking. With plain objects, serialization is free.

**No extension packs for IDB operators.** The SQL ORM must be extensible because adapters (pgvector, PostGIS) contribute new operators that require new AST node types and new lowering logic. IDB has no such extension system — operators are JS primitives. Adding a new operator means adding a string to `IdbFilterOp` and a new case in `evaluateFilter`. Both approaches require the same effort, but plain objects don't require a new class and don't require all visitors to be updated.

## Compile-time safety

The `IdbFilterExpr` discriminated union provides the same exhaustiveness checking as class hierarchies when used in `switch` statements with TypeScript's `never` guard:

```ts
function evaluateFilter(expr: IdbFilterExpr, row: Record<string, unknown>): boolean {
  switch (expr.kind) {
    case 'field': ...
    case 'and': ...
    case 'or': ...
    case 'not': ...
    case 'null-check': ...
    default: {
      const _exhaustive: never = expr;
      throw new Error(`Unknown filter kind: ${(_exhaustive as IdbFilterExpr).kind}`);
    }
  }
}
```

Adding a new variant to `IdbFilterExpr` without updating `evaluateFilter` is a compile error, same as with a class visitor.

## What we deliberately did not do

**Class-based nodes with `freezeNode(this)`:** Would require a constructor per node type, a `kind` discriminant on each class, and a visitor interface for lowering. This adds abstraction overhead with no payoff in IDB's evaluation model.

**Codec trait-gating on operators:** Limiting operators by field type (e.g. only `numeric` fields get `gt`/`lt`) is an ergonomic feature that the upstream SQL ORM provides. IDB's evaluation uses JS semantics for all comparisons — a `gt` on a string field is legal JS (`"b" > "a"` is `true`). We let users write what they mean and let JS semantics apply, consistent with how the rest of the IDB layer works.

## Future considerations

If a future extension pack contributes a new IDB operator (e.g. a GeoJSON `withinBounds` for a hypothetical spatial extension), it can add a new `IdbFilterOp` string and a new case in `evaluateFilter`. The discriminated union extends naturally. The outbox serialization path remains unchanged because new variants are still plain JSON-safe objects.

## Related

- `adapter-idb/src/core/idb-filter-expr.ts` — the AST types and factory helpers
- `adapter-idb/src/core/filter-eval.ts` — `evaluateFilter()` implementation
- `client-idb/src/core/model-accessor.ts` — the `IdbModelAccessor` proxy that builds filter exprs
- Upstream vendor pattern: `three-layer-polymorphic-ir.md` — the pattern we chose not to follow
- [ADR 004](ADR%20004%20-%20Driver%20Isolation%20via%20Row%20Filter%20Closure.md) — why the driver never sees `IdbFilterExpr` directly
