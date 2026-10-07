# ADR 021: A query planner chooses the IndexedDB access path

- **Status:** Accepted
- **Date:** 2026-10-05
- **Area:** ORM

## Summary

`client-idb` chooses how to read a store with a small planner. The planner looks at a query's filter and ordering, and at the indexes the contract declares. It picks a primary-key or index access path, and the ORM lowers that choice to a driver plan. Three rules keep the planner safe:

- **The access path is a superset.** The planner may read more rows than match, but never fewer. The ORM always reapplies the full filter to every row it gets back.
- **Only exact plans skip the rows.** `count()` and existence checks use IndexedDB's native `count()` and key reads only when the key ranges alone decide the match.
- **Without `orderBy`, order is unspecified.** The access path decides the order of rows, so callers who need an order must ask for it.

This ADR partly supersedes [ADR 017](ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md). The planner replaces its rules for native `count()` and key-only reads, and it removes the "needs a query planner" items that ADR 017 deferred.

## Context

Before the planner, `client-idb` had a few separate fast paths. Indexed equality, an OR of indexed equalities, native `count()` and key-only reads each had their own checks for when they were safe. Everything else scanned the whole store and filtered in memory. The paths had three problems:

- **They covered few shapes.** Range filters (`lt`, `gte`), `in`, compound-index prefixes, and `orderBy` with `take` all scanned every record, even when an index could serve them.
- **Each path carried its own safety argument.** There was no single place to check that an access path could not drop a matching row.
- **Writes scanned too.** `updateAll`, `deleteAll`, and the child lookups of referential actions read the whole store, so a cascade cost as much as the size of the child store.

The cost of a scan grows with the store, and a store can hold thousands of rows on a user's device. The first step toward the planner removed the old fast paths, so that every read scanned and the new behavior had a clean baseline. The planner then added access paths back one family at a time.

## Decision

### 1. Three stages: catalog, plan, lowering

- **Catalog.** `buildCatalog` reads the contract once per store and records the primary key, the indexes and the codec of each field. It keeps no IndexedDB handles, and it is cached for the life of the contract.
- **Plan.** `planQuery(catalog, request)` is a pure function. It takes the filter, the `orderBy` and the `take`, and returns a `LogicalPlan`: an access path (`full`, `empty`, or key `ranges` on one source), an optional scan direction, and an `exact` flag. It never opens a database or reads data.
- **Lowering.** `lowerRows`, `lowerCount`, `lowerExists` and `lowerWrite` turn a logical plan into a driver plan, such as `key-get`, `get-all`, `cursor-scan`, `count`, `keys` or `scan-write`. The row, count and existence functions also return a synchronous `finish` step that shapes the combined result. `lowerWrite` returns either a cursor-scan plan, or a row read that must finish before any keyed write begins; only that row read has a `finish` step.

The split keeps the decision testable without IndexedDB. The plan-shape gate (`test/plan-shape-gate.test.ts`) runs real queries and records what IndexedDB was asked to do, so a change to planning shows up as a change to a table.

### 2. The access path is a superset, and the filter always runs again

An access path only narrows where the ORM looks. It is never trusted to decide a match:

- The planner turns a filter into key ranges only when every row that matches the filter has a key inside those ranges. If it can't prove that, it falls back to a full scan.
- Every lowering path applies the full filter to the rows it receives, even when a range already implies part of it. Cursor paths filter before pagination, so their rows pass the filter twice. We accept that cost for a single safety rule.
- Indexes omit records whose key value isn't a valid IndexedDB key, such as `null`. A filter on a value that is a valid key never matches those records, so a range on that value is safe. Inclusive comparisons on `double` and `date` fields can match `NaN` or an invalid date, which an index also omits. The planner uses such a bound only when the filter rejects those values. Fields of a compound index that the filter leaves unconstrained must always hold valid keys, or the planner doesn't use the index.
- `multiEntry` indexes are never used, because one row can have several entries.

### 3. Shapes the planner accelerates

| Query shape                                                              | Access path                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Equality or `in` on the primary key or an indexed field                  | One point range per value                                           |
| `lt`, `lte`, `gt`, `gte` and their combinations on an indexed field      | One key range                                                       |
| `startsWith` on a string index                                           | One key range from the prefix to its successor                      |
| Equality on a leading prefix of a compound index, with an optional range | Compound key range                                                  |
| OR of equalities or `in` on one field                                    | The same as `in`                                                    |
| Single-field `orderBy` with `take`                                       | Index cursor in that order, with an early stop (see the note below) |

Shapes that aren't accelerated scan the store and filter in memory:

- `not`, and an OR whose branches use different fields or operators.
- Filters on relations.
- `orderBy` with more than one field.
- Queries with an unindexed or `multiEntry` predicate and no other usable source. If another source narrows the candidates, the ORM still applies the full filter.
- A source whose lookup values multiply to more than 1,024 prefixes. The planner rejects that source, not the whole query. Another usable source can still serve it; the query scans the store only when none can.

A single-field `orderBy` with `take` walks an index in order only when that index is also the source that serves the filter, or when the filter needs no source and an index covers the `orderBy` field with complete keys. If the filter picks a source on a different field, the query reads that source's range and sorts the rows in memory.

When several sources can serve a query, the planner picks the highest-ranked candidate. The ranking is a fixed heuristic, not a measured selectivity: a unique-index point, then a primary-key point, an index point, a compound prefix, a two-sided range and a one-sided range. Ties go to fewer ranges, then to the primary key, then to declaration order.

### 4. Exact plans use native count and key reads

A plan is `exact` when the key ranges consume every condition in the filter. Then the number of matching records is the number of entries in the ranges, and one entry proves that a row exists.

- **`count()`** sends a `count` plan per range and adds the results. It does this only for an exact plan with no `skip`, `take` or extra row filter. The planner emits disjoint ranges on a source that isn't `multiEntry`, so no row is counted twice.
- **Existence checks** send a `keys` plan with `take: 1` per range. Foreign-key checks and `restrict` use this path, including for a child index on the foreign key. A `null` value in a `restrict` check now references no child rows.
- **Otherwise** the ORM reads the rows in the index range and counts or tests the ones that pass the filter.

### 5. Writes use the same access paths

`updateAll`, `deleteAll`, `update`, `upsert`, nested relation writes and referential actions use the planner's selected access path. This can be a planned range or a full-store scan. Primary keys stay immutable ([ADR 020](ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md)). An update that changes a primary key fails and rolls back the whole mutation. Non-primary fields in an index can still change. Two cases need care, because a write can change what the walk sees:

- **A patch that changes fields used by the walked index.** The ORM reads and collects every match first, then writes each row by its unchanged primary key. For example, changing an indexed `status` from `"todo"` to `"done"` moves the index entry while the row's `id` stays fixed. Updating during the index walk could make that entry re-enter the cursor or a later range.
- **Several ranges with a limit.** The limit applies to the combined matches, so the ORM collects first as well.

All reads and writes of one operation stay in the same transaction. No step waits on anything that yields to another macrotask between requests, such as a timer or a network call. Awaiting an IndexedDB request is fine, because its continuation runs as a microtask before the transaction can auto-commit ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)).

### 6. Row order is unspecified without `orderBy`

The access path decides the order in which rows come back. An index range returns rows in key order, a full scan in primary-key order, and a multi-range plan in range order. The planner is free to change the path, so the order can change from one release to the next. Without `orderBy`, `skip`, `take` and `first` may select different matching rows as the path changes. Rows tied on every `orderBy` field also have no defined order. A caller who needs stable pages adds a unique field to `orderBy`.

This matches Prisma, which also defines no order without `orderBy`.

## Alternatives considered

- **Cost-based choice using statistics.** Reading cardinality from the store costs an extra request per query, and the numbers go stale. The fixed ranking in section 3 is cheap and predictable. Revisit it if a real query picks the wrong index.
- **Trusting exact index ranges and skipping the filter.** This saves one pass over the rows, but it makes every planner bug a wrong-result bug. A repeated filter costs little next to the IndexedDB request.
- **Multi-index intersection for AND filters on two indexed fields.** The planner picks one source and filters the rest. Intersection needs two scans and a join in memory, with no consumer asking for it.
- **Using `multiEntry` indexes.** An array contains-query could use one, but the count and ordering rules differ because a row has several entries. No query needs it yet.
- **Generating specialized code per query.** This is more code to review and test than interpreting a small plan.

## Consequences

- **Fewer records read.** Indexed reads, counts, existence checks and write lookups touch only the records in the planned ranges. The plan-shape gate pins this for each shape at two store sizes.
- **Row order may change.** Callers that relied on the scan order without `orderBy` get a different order for indexed queries. The changeset for the planner says so.
- **A new accelerated shape needs a gate entry.** Add the shape to the plan-shape gate in the same change. The diff of the table is the evidence that the shape improved and nothing regressed.
- **Indexes matter more.** A contract with no index on a filtered field still scans. Authors add `@@index` for fields they filter on.
- **The gate counts requests in `fake-indexeddb`.** It doesn't measure timing. The benchmark app measures timing in Chromium, and we haven't yet checked WebKit or Firefox.

## Related

- [ADR 003](ADR%20003%20-%20Plain%20Frozen%20Objects%20for%20Filter%20AST.md): the filter AST the planner reads.
- [ADR 004](ADR%20004%20-%20Driver%20Isolation%20via%20Row%20Filter%20Closure.md): the driver receives the full filter as a function.
- [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md): no `await` inside transactions.
- [ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md): foreign-key checks and referential actions.
- [ADR 017](ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md): native count and key-only reads, which this ADR partly supersedes.
- `client-idb/src/core/planner/`: `catalog.ts`, `plan.ts`, `lower.ts` and `explain.ts`.
- `client-idb/test/plan-shape-gate.test.ts`: the plan-shape gate.
