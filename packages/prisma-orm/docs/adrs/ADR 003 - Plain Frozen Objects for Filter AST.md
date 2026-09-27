# ADR 003: Plain frozen objects for the filter AST

- **Status:** Accepted
- **Date:** 2026-05-24
- **Area:** Query layer

## Summary

Query filters (`IdbFilterExpr`) are plain, frozen objects with a `kind` field, not class instances. A single recursive function, `evaluateFilter(expr, row)`, evaluates them. The upstream SQL and Mongo ORMs use class-based nodes because they compile filters into query languages. IndexedDB filters run as plain JavaScript over each row, so the classes would add structure with no benefit.

## Context

The upstream framework builds query expressions from classes. There is a framework interface, an abstract base class per family, and a concrete class per target. Each node freezes itself in its constructor, and a visitor walks the tree to compile it.

The IndexedDB ORM needs filters that support:

- comparisons: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `in`, `notIn`
- string matching: `contains`, `startsWith`, `endsWith`
- combinators: `and`, `or`, `not`
- null checks: `isNull`, `isNotNull`

## Decision

Represent each filter node as a frozen object, discriminated by `kind`:

```ts
// Built by helpers such as fieldFilter(), andExpr() and orExpr()
Object.freeze({ kind: "field", field: "name", op: "contains", value: "Alice" });
Object.freeze({ kind: "and", exprs: Object.freeze([...]) });
```

Evaluate them with one function that switches on `kind`. TypeScript still checks that every case is handled:

```ts
function evaluateFilter(expr: IdbFilterExpr, row: Record<string, unknown>): boolean {
  switch (expr.kind) {
    case "field": ...
    case "and": ...
    case "or": ...
    case "not": ...
    case "null-check": ...
    default: {
      const _exhaustive: never = expr;
      throw new Error(`Unknown filter kind: ${(_exhaustive as IdbFilterExpr).kind}`);
    }
  }
}
```

Adding a variant to `IdbFilterExpr` without handling it in `evaluateFilter` is a compile error, just as it would be with a visitor.

### Why this fits IndexedDB

- **Filters are evaluated, not compiled.** A visitor suits a compiler that turns a tree into SQL. `evaluateFilter` just reads `row[field]` and compares it with the filter's value. One `switch` is easier to read than a class hierarchy.
- **Every operator works on every field.** The SQL ORM only offers some operators on some column types. For example, `gt` needs a type with an ordering, because the generated SQL depends on the column type. IndexedDB can compare any of its key types, so there is nothing to restrict.
- **No operator extensions.** SQL adapters such as pgvector add operators, which need new node types and new compile logic. IndexedDB has no such extension system. Adding an operator means adding a string to `IdbFilterOp` and a case to `evaluateFilter`.
- **They serialize to JSON as they are.** No `toJSON()` methods or custom serializers are needed. We expected sync to send filters to the server. It ended up scoping data by ownership instead ([ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md)), so nothing depends on this today.

## Alternatives considered

- **Class-based nodes that freeze themselves**, as upstream does. This needs a constructor per node type and a visitor interface, which adds abstraction for no gain here. Rejected.
- **Restricting operators by field type**, as the SQL ORM does. Every value IndexedDB can store as a key has an order, so every comparison has an answer. We let users write what they mean. Rejected.
- **Plain JavaScript operators (`===`, `>`).** This was the first implementation. Values read back from IndexedDB are fresh objects, so `===` never matched two equal `Date`s or byte arrays. A filter on an unindexed `DateTime` field then returned nothing, while the same filter on an indexed field worked through a key range. Replaced.

## Consequences

- New operators are cheap to add: one string in `IdbFilterOp`, one case in `evaluateFilter`.
- A future extension could add an operator the same way, for example a spatial `withinBounds`, without changing the representation.
- Comparisons match IndexedDB's key comparison (`compareFieldValues` and `fieldValuesEqual` in `target-idb/src/core/key-compare.ts`). A filter gives the same answer whether it runs in memory or through an index key range. Values that aren't valid keys, such as booleans, fall back to JavaScript's operators.

## Related

- `adapter-idb/src/core/idb-filter-expr.ts`: the types and the helper functions that build them.
- `adapter-idb/src/core/filter-eval.ts`: `evaluateFilter`.
- `client-idb/src/core/model-accessor.ts`: builds filters from ORM calls.
- [ADR 004](ADR%20004%20-%20Driver%20Isolation%20via%20Row%20Filter%20Closure.md): why the driver never sees these objects directly.
