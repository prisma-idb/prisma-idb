# Phase 10 — IDB query planner

Benchmark foundation (kit, probe gate, `apps/prisma-orm-benchmark`, CI matrix)
merged in #233. This file is the planner PR's working plan, on branch
`feat/query-planner`. User reviews each chunk before it's committed; do not
commit until told. Delete this file once the phase is done.

## Shape

Logical/physical split, like Prisma's QueryPlan → ExecutionPlan, but IDB has
no engine underneath, so client-idb owns optimization:

- `planner/catalog.ts` — per-store catalog built once per contract (WeakMap):
  primary key path, indexes (fields, unique, multiEntry), per-field codec +
  nullability.
- `planner/plan.ts` — pure `planQuery(catalog, request)` → `LogicalPlan`:
  `{ access, residual, exact, pkOrdered }`. Access is `full`, `empty`, or
  `ranges` over one source (primary key or a named index), or a `union` of
  those. Ranges are plain descriptors (`{ lower?, upper?, lowerOpen, upperOpen }`
  / point), never `IDBKeyRange` — the planner runs without IndexedDB.
- `planner/execute.ts` — lowers a LogicalPlan for a purpose (`rows`, `count`,
  `exists`, `write`) into driver ops, builds `IDBKeyRange` at this edge, runs
  them through a `PlanRunner` (either `executor.query` or `scope.execute`),
  then dedupes by primary key, applies the residual, sorts, skips/takes.
- `explain()` on a LogicalPlan for tests and the gate.

Every access path returns a superset of the matches; the residual is the whole
original filter (cheap to re-evaluate, and makes correctness depend only on
the superset property). `exact` is tracked separately for native count / key-only
existence.

## Rules

- Candidates per conjunction: primary key and each non-multiEntry index.
  Consume `eq`/`in` on a key-path prefix, then at most one range atom
  (`gt/gte/lt/lte`, `startsWith`) on the next member. Multiple range atoms on
  one field intersect. Contradictory → `empty`.
- Using a strict prefix of a compound key path is only allowed when every
  trailing member is non-nullable and key-typed (IDB omits entries with a
  non-key member).
- Range atoms (and startsWith) only on fields whose codec is in an explicit
  key-typed list: string, int32, double, date, decimal(string), bytes. Not by
  `order` trait (bigint has it but isn't a key). `evaluateFilter`'s gt/lt fall
  back to JS `<`/`>` for non-keys, so a range must never be used where a
  non-key value could be stored. startsWith only on string codec.
- `eq`/`in` need every value `isValidIdbKey`; any invalid value → no path.
  Empty `in` / non-array `in` → `empty`. Dedupe `in` values by key compare.
- OR: each branch planned as its own conjunction; any branch without a path →
  OR unusable. Branch ranges on the same source merge; overlapping ranges
  dedupe (points by key compare); union always dedupes rows by PK.
- Cost (rule-based, no stats, no count probe in v1): unique full-key point 1,
  PK point 1, index point 10, compound prefix point 20, two-sided range 40,
  one-sided range / startsWith 80, full 1000; union = sum. Tie → fewer ranges,
  then PK over index, then declaration order.
- Order: without orderBy, results are in primary-key order for every access
  path (behavior change for OR, which used to return branch order). A path is
  `pkOrdered` for PK ranges and for a single full-key point on an index.
  Non-pkOrdered + (skip/take or first) → read whole range, sort by PK, slice.
  asc single-field orderBy on the range's own index field may use index order
  (ties in PK order match a stable sort); desc may not.
- Physical choice: take + pkOrdered + no comparator → `cursor-scan` with early
  stop. Otherwise `get-all` (getAll on store/index, with count when no residual
  and pkOrdered). Full scan with a residual stays a cursor (don't
  materialize the whole store at once).
- Native count: `exact` and (one range, or disjoint deduped points on one
  source), source not multiEntry. Sum per-range counts. clamp skip/take.
- Exists (FK checks, restrict): exact → `keys` take 1 (getKey on index gives
  the PK); otherwise read path with take 1.
- scan-write over an index cursor only when the patch doesn't touch the
  index's fields, or the range is a single full-key point; delete always OK.
  `take` on scan-write requires pkOrdered. Otherwise read keys first, write by key.
  Returned rows re-sorted by PK when the source isn't pkOrdered.
- Inside a mutation scope never cross a macrotask between requests.

## Chunks (each green on its own, reviewed, then committed)

1. Cleanup — delete extractIndexEqualityHint/extractIndexOrHint, OR multi-scan,
   native-count fast paths, relation-loader findRangeSource, mutation-executor
   pkEqualityRange/primaryKeyRange/firstKeyInRange, buildFieldToIndexMap/
   getIndexForField. Keep key-get for findUnique. Drop plan-shape assertions
   from index-acceleration/native-count/key-only-reads tests, keep row
   assertions. Gate EXPECTED diff shows what was lost.
2. Driver vocabulary — rename `index-get` → `get-all` with optional indexName,
   range, count; `scan-write` gains indexName/range. sync-executor switch,
   driver tests, changeset.
3. Pure planner + catalog + unit tests (no IDB).
4. Lowering/execution + PlanRunner.
5. Read paths (store-accessor all/first/count/aggregate/groupBy/upsert lookup,
   relation-loader).
6. Mutation paths (every mutation-executor lookup, scan-writes with ranges,
   deleteAll/updateAll).
7. Differential fuzz (reference = evaluateFilter over all rows in PK order,
   stable sort, skip/take; also updateAll/deleteAll/count comparing store
   contents) + gate EXPECTED + local Tier-2.
8. ADR 020 (partly supersedes ADR 017's native count / key-only reads: they
   now come from the planner; update INDEX.md), ARCHITECTURE.md plan-building
   section, todo.md 11/12-16/20, plans/README.md phase table, changesets
   (client-idb: OR without orderBy now returns PK order; driver-idb: plan
   vocabulary), delete this file. apps/docs indexes.mdx is the old
   generator's docs, not ours.

Don't push until the planner chunks land: after chunk 1 alone, Tier 2 flags
big regressions and "Changeset required" fails.
