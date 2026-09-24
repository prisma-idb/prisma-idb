# Phase 10 — Benchmarking Foundation + IDB Query Planner

Stack layer: branches off `main` after **Phase 9** (IndexedDB Web API
feature parity — see
[`PLAN_9.0_idb_web_api_feature_parity.md`](PLAN_9.0_idb_web_api_feature_parity.md))
lands, as `feat/query-planner`. Source-grounded survey, not yet
implementation — mirrors [`PLAN_8.0`](PLAN_8.0_prisma8_port.md)'s role:
resolve the open decisions and lay out the phase stack before code moves.

**Renumbered from an earlier draft of this survey (originally "Phase 9").**
The user's call: compound-index support is a real native-IndexedDB feature
our contract IR doesn't expose (§1.3 below, and Phase 9 §1), and it changes
what the planner's multi-field `AND` strategy should even be. Scoping that
out first, as its own phase, beats building planner machinery around a
narrower-than-native index surface and re-deriving it later.

## 0. Why this phase exists

`todo.md`'s "ORM follow-ups" section has three linked, unclosed items:

- Line 12: only `eq` conditions are ever accelerated — range operators
  (`gt`/`lt`/`gte`/`lte`) always fall back to a full cursor scan.
- Line 13: OR-acceleration only fires when _every_ branch is a bare
  `field eq value` on an indexed field; realistic shorthand like
  `{OR: [{a, b}, {c}]}` (AND-of-fields per branch) falls back to a full scan,
  and mixed indexed/non-indexed branches aren't handled either. Flagged in
  that entry as "a real redesign, not a tweak — own branch."
- Line 14: whatever the planner becomes should also cover
  `mutation-executor.ts`'s FK/referential-action lookups
  (`buildChildFilterFromRow`, `validateScalarFks`, `findRowByCriterion`),
  which bypass `query-shaping.ts` entirely today and always do a full
  `cursor-scan`, even though every one of them is a known-shape equality (or
  compound-equality) check on a relation's declared fields.

The user's ask adds two hard constraints on top of closing these:

1. **Benchmarking has to exist first**, and it has to produce numbers that
   distinguish a real improvement from CI noise — not "the diff looks right
   so it must be faster."
2. Once that gate exists, the hand-written index-acceleration special-cases
   in `client-idb` get deleted in favor of one real planner, "unless [kept
   cases are] for very specific and beneficial reasons" — i.e. any surviving
   hand-written fast path has to justify itself against the same benchmark
   gate, not just assumption.

## 1. Current-state findings

### 1.1 The thing being replaced

`packages/prisma-orm/client-idb/src/core/query-shaping.ts` is ~200 lines of
pattern-matching on the filter AST shape:

- `extractIndexEqualityHint` — peels one `field eq value` node off a flat or
  `AND`-flattened filter if the field has an index or is the store's
  `keyPath`. `store-accessor.ts:983` calls it, then hand-builds
  `{ kind: "cursor-scan", indexName, range: IDBKeyRange.only(value), filter: remainingFilter }`.
- `extractIndexOrHint` — same idea for an `OR` node where _every_ branch is a
  bare indexed-eq. `store-accessor.ts:871` calls it, then issues one
  `cursor-scan` per branch and unions/dedupes.
- Both are called again, separately, near line 500 for the relation-loader's
  refined `include()` child scans — the same heuristic, duplicated at a
  second call site.

This is exactly the "monkey-patched, hand-written-case" code the user means:
it recognizes two specific AST shapes and gives up (full scan) on everything
else, including shapes that are one AST-flattening step away from being
just as accelerable.

### 1.2 What the driver already gives the planner to target

`driver-idb/src/core/plan-body.ts` already defines a small physical-plan
vocabulary, and it's more capable than `query-shaping.ts` currently uses:

- `cursor-scan` — takes an optional `indexName`, an optional `range:
IDBKeyRange` (not just point ranges — `IDBKeyRange.bound`/`lowerBound`/
  `upperBound` all work here already), an in-memory `filter`, `comparator`,
  `skip`, `take`. **Range-operator acceleration (`todo.md:12`) needs zero
  driver changes** — it's purely a `client-idb`-side gap in what
  `query-shaping.ts` knows how to recognize.
- `key-get` — O(1) `store.get(key)` by primary key. Used today, correctly,
  only by `findUnique` on the `@id` field (`store-accessor.ts:611`).
- `index-get` — documented as "index-based range lookup... used for
  `findUnique` on `@@unique` fields and index-accelerated `findMany` on
  `@@index` fields" (`plan-body.ts:90-100`), and fully implemented in the
  executor (`driver-idb/src/core/execute/ops.ts:53`). **`client-idb` never
  constructs this plan kind.** Every current index-accelerated path
  (`store-accessor.ts:995,1017,1059`) goes through `cursor-scan` with a
  `range`, even for a plain single-value equality that `index-get` was
  clearly built for. The planner should be the thing that finally uses this
  operator, not just add new ones.
- `range: IDBKeyRange` on both `cursor-scan` and `index-get` works over
  array keys natively once Phase 9 lands array-`keyPath` indexes/stores —
  `IDBKeyRange.bound([a,b], [a,c])` is standard IndexedDB, so **the physical
  layer needs no changes to support compound-index acceleration either**;
  it's purely about the _logical_ layer knowing a compound index exists and
  how to build a matching range against it.

So the physical layer is in reasonable shape; the gap is almost entirely in
the logical layer (`client-idb`) that decides which physical plan to emit.

### 1.3 The compound-index ceiling — closed by Phase 9, not this phase

An earlier draft of this survey treated missing compound-index support as a
non-goal to design around (single-index-pick + residual-filter, or key-set
intersection). The user's correction: that's backwards — compound indexes
are a native IndexedDB feature (`createIndex(name, ['a','b'], {...})`,
`createObjectStore(name, {keyPath: ['a','b']})`), and our contract IR not
exposing them is an emitter gap, not a platform ceiling worth designing
around. Phase 9 (9.1 compound primary keys, 9.2 compound secondary indexes)
closes this before this phase starts. See §3.2 for how that changes the
planner's `AND` strategy.

### 1.4 Prior art check: `vendor/prisma`

Confirmed there's no transferable design doc, as expected — Prisma's
SQL and Mongo targets delegate query optimization to the underlying engine
(Postgres/SQLite planner, MongoDB's own index selection); Prisma's own layer
only compiles lane input into a `QueryPlan`, then lowers to an
`ExecutionPlan` for the driver to execute (`vendor/prisma/docs/architecture
docs/subsystems/3. Query Lanes.md`, "Unified Plan Model"). IDB has no such
engine underneath it — it's a raw keyed store with manual cursor iteration —
so the IDB family is the one place in this whole stack that has to own
optimization itself. The one thing worth carrying over is the naming/layering
convention: a **pure, lane-side compile step** (filter AST + index metadata →
plan) feeding a **driver-side execution step** (plan → rows), matching the
`QueryPlan → ExecutionPlan` split already implicit in `IdbPlanBody` being
imported as `ExecutionPlan` (`plan-body.ts:1`). Worth stating explicitly in
the planner's ADR so it reads as "the missing lane-compile step for a family
with no native optimizer," not a bespoke one-off.

### 1.5 Benchmarking precedent: `apps/benchmark`

The old generator (`packages/generator` → `@prisma-idb/idb-client-generator`)
already has exactly the rigor being asked for, at `apps/benchmark`:

- Ops cover CRUD, `findMany` by completion / `contains`, sorted/paginated
  reads, relation includes (`apps/benchmark/README.md`).
- CI gate (`.github/workflows/benchmark.yml`, ~15 commits of hardening per
  git log) runs PR-head and PR-base **on the same runner** back-to-back to
  kill VM-to-VM variance, computes a **bootstrap 95% CI on the median
  latency delta**, and only fails the gate when the CI lower bound exceeds a
  threshold — insufficient/mismatched samples degrade to advisory, not a
  hard fail. New ops are reported but don't fail the gate; removed baseline
  ops do. Results publish to a public `benchmark-data` branch; PRs get a
  sticky comment with a per-operation delta table.
- This pipeline is the expensive, already-debugged part. It should be
  reused, not rebuilt, for `client-idb`.

`apps/benchmark` is hard-wired to the old generator's output shape (schema
in `src/prisma/schema.prisma`, generated client in `src/lib/prisma-idb`,
Next.js dashboard UI in `src/components/charts`). `client-idb`'s authoring
surface (`defineContract`, `createAutoMigratingIdbClient`, TS-DSL/PSL) is a
different enough shape that bolting it into the same app's UI is more
retrofit cost than reuse. See §3.1 for the recommended split.

## 2. What "measurable" means here (this is the load-bearing decision)

Two separate gates, not one, because they answer different questions and
have very different noise floors:

**Tier 1 — deterministic plan-shape gate (hard-blocking, runs in Node/vitest,
fake-indexeddb is fine here).** fake-indexeddb's cost curve (in-memory JS Map)
is nothing like Chromium's real (LevelDB-backed) IndexedDB, so it must never
be trusted for _timing_. But it's a real IndexedDB-semantics implementation
for _structural_ facts: which plan kind ran, whether it hit an index, how
many records were examined/deserialized before filtering, how many
`cursor.continue()` steps happened. `store-accessor.ts:882` already overrides
the AST kind "for middleware introspection" while keeping the real
`idbPlan` — that's the existing observability seam to extend (surface the new
counters alongside it) rather than inventing a second instrumentation path
through `executeIdbPlan`/`execute/ops.ts`. Assert per query pattern: "this
filter must produce plan kind X and must examine ≤ N records," where N
should stay flat (not scale with dataset size) for an index-accelerated case
and scale linearly for a full scan. This is an EXPLAIN-equivalent — it can't
flake, and it's the artifact that proves a planner change actually changed
the physical plan, independent of any wall-clock noise. This is the primary
CI-blocking gate.

**Tier 2 — wall-clock confirmation (advisory + threshold, real Chromium via
Playwright, reusing `apps/benchmark`'s bootstrap-CI comparison machinery).**
Confirms Tier 1's counters actually translate into real time saved in a real
browser (structured-clone deserialization cost and per-`continue()`
round-trip cost — the two things fake-indexeddb has neither of — dominate
real IDB latency). Same same-runner-comparison, same bootstrap-CI-on-median,
same advisory-on-insufficient-samples design as the existing pipeline.

**Correctness gate, orthogonal to both of the above.** The planner rewrite
must be semantics-preserving. The highest-yield test is differential: for a
generated corpus of filter shapes × datasets, assert the planner-chosen
(possibly accelerated) result set equals a forced-full-scan reference — same
rows, same order after `orderBy`. This is what actually catches the
`todo.md:13` bug class (per-branch OR extraction silently dropping or
duplicating rows), not just "the happy path I thought of passes."

## 3. Open decisions

### 3.1 Benchmark app: extend `apps/benchmark` or stand up a new app?

**Recommendation: new `apps/prisma-next-benchmark` app, sharing tooling, not
UI.** Extract the client-agnostic pieces already written client-agnostically
— `src/lib/benchmark/{stats.ts,types.ts,config-validation.ts}` (bootstrap CI,
threshold-gate math, config schema) and the two CI scripts
(`scripts/compare-benchmark-results.ts`, `scripts/publish-benchmark-pr-comment.ts`)
— into a small internal workspace package (e.g. `packages/internal/benchmark-kit`)
that both apps import. `operations.ts`/`runner.ts` stay per-app because they
call each client's specific API shape (old generator's generated methods vs.
`client-idb`'s `defineContract`-driven accessor). Extend
`.github/workflows/benchmark.yml` to run both apps' `benchmark:ci` (matrix or
two jobs), reusing the one comparison/report step, tagged per app so PR
comments distinguish the two suites. Rejected alternative: retrofitting
`apps/benchmark`'s existing UI/schema to also drive `client-idb` — the
authoring surface is different enough (contract-first vs. old-style
`schema.prisma` codegen) that this is more retrofit than reuse, and it
couples the two apps' release cadence for no real benefit since the
Tier-1/Tier-2 gate machinery is what's actually being reused. Flag if you'd
rather keep everything in one app — this is the one call in this survey
that's genuinely a judgment call, not a technical finding.

### 3.2 Multi-field `AND` strategy, now that compound indexes exist (Phase 9)

With Phase 9 closing §1.3, a multi-field `AND` has three tiers to consider,
in order of preference:

1. **Exact or prefix match against a real compound index** (Phase 9.2)
   — build one `IDBKeyRange` over the compound index directly. This is now
   the primary strategy, not a fallback.
2. **Single-index-pick + residual-filter** — when no compound index covers
   the field set (or only covers a subset as a usable prefix), pick the most
   selective single-field index for one condition and filter the rest in
   memory.
3. **Key-set intersection** across two independent single-field index scans
   — a real technique, but its value depends on whether `IDBIndex.count(range)`
   (native as of Phase 9.3) and key-only cursors (Phase 9.4) are cheap enough
   in real Chromium to make a selectivity-driven choice worthwhile. Measure
   with the Tier 2 harness (§2) before adding this tier's complexity — land
   tiers 1–2 first since they alone close `todo.md:12/13`'s correctness gaps,
   then decide on intersection as a follow-up once real numbers exist.

## 4. Phase stack

| Phase | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Depends on                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 10.1  | Extract `stats`/`config-validation`/comparison-script logic out of `apps/benchmark` into a shared `benchmark-kit` package; old app re-points imports; zero behavior change, verified by identical `benchmark:compare` output on a fixed fixture pair                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                              |
| 10.2  | New `apps/prisma-next-benchmark`: schema/dataset designed backwards from the planner's target cases (indexed range filter, mixed-selectivity `AND` — now including a real compound-indexed case, the `{OR:[{a,b},{c}]}` shape, FK-heavy nested writes/cascades hitting `mutation-executor.ts`'s lookups) — not a port of the old app's CRUD-ish suite. Wired into `benchmark.yml` via 10.1's shared kit. **Baseline captured and committed against today's monkey-patched `query-shaping.ts` before any planner code is written** — this is the pre/post comparison's control group                                                                                                                   | 10.1, Phase 9                  |
| 10.3  | Extend the existing `store-accessor.ts:882` middleware-introspection seam with plan-kind + records-examined/cursor-step counters; add the Node/vitest hard-blocking gate (§2 Tier 1) asserting plan shape and bounded row-examination per query pattern, captured against the same pre-planner `main` behavior as 10.2's baseline. Independent of 10.1/10.2's app work, but — like 10.2 — **must land and be green against current behavior before 10.4 changes anything it measures**                                                                                                                                                                                                                | Phase 9                        |
| 10.4  | The planner itself: a pure function (filter AST + index metadata + `orderBy` → `IdbPlanBody`) replacing `extractIndexEqualityHint`/`extractIndexOrHint`. Covers range acceleration (`todo.md:12`), correct per-branch OR extraction with mixed indexed/non-indexed branches (`todo.md:13`), the tiered multi-field `AND` strategy (§3.2) now backed by real compound indexes, and finally makes real use of the existing-but-dead `index-get` plan kind (§1.2) for plain equality instead of `cursor-scan` + `IDBKeyRange.only`. Differential correctness fuzz tests (§2) are written alongside, not after                                                                                            | 10.2, 10.3 baselines committed |
| 10.5  | Wire the planner into `store-accessor.ts` (top-level scans + the duplicated `include()` refinement call site) and extract the shared "resolve field-equality/range against a store's index map" primitive for `mutation-executor.ts`'s `buildChildFilterFromRow`/`validateScalarFks`/`findRowByCriterion` (`todo.md:14` — likely the single biggest real-world win, since these currently always full-scan; builds on Phase 9.4's key-only-read primitive where only existence/keys are needed). Delete `query-shaping.ts`'s old heuristic functions once nothing calls them. Re-run Tier 1 + Tier 2 gates against the 10.2/10.3 baselines and confirm non-regression / improvement with real numbers | 10.4                           |
| 10.6  | ADR (next free number in `packages/prisma-orm/docs/adrs/` at authoring time — expected to be 018, one after Phase 9.5's; re-check, since any other ADR landing first shifts both) documenting the logical-plan/physical-plan split, its relationship to Prisma's `QueryPlan → ExecutionPlan` model (§1.4), the tiered `AND`/cost model and why it's rule-based-plus-`count()`-probe rather than a histogram optimizer, and the Tier 1/Tier 2 gate contract. Close `todo.md:12/13/14`                                                                                                                                                                                                                  | 10.5                           |

## 5. Non-goals

- Compound/multi-field native IndexedDB indexes in the contract IR — **not
  a non-goal anymore; delivered by Phase 9** (9.1 compound primary keys, 9.2
  compound secondary indexes). This phase consumes that work, it doesn't
  redo it.
- A histogram-based or statistics-persisting cost optimizer. Per the advisor
  review of this survey: rule-based enumeration plus one cheap
  `IDBIndex.count(range)` probe for tie-breaks is the right ceiling for a
  single-tenant, no-background-stats-collector embedded store; a real cost
  optimizer is solving a problem this system doesn't have.
- Cross-store join reordering / join planning — out of scope; relation
  loading (`relation-loader.ts`) is untouched except for reusing the same
  index-hint primitive at its existing call site.
- Anything in `packages/generator` (the old codegen). This phase is scoped
  to the `packages/prisma-orm` family.

## 6. What's explicitly allowed to stay hand-written

`findUnique` on the `@id` field going straight to `key-get`
(`store-accessor.ts:611`) is not a heuristic guess — a primary-key point
lookup has exactly one correct physical plan, there's nothing for a planner
to decide. That stays as-is. Any _other_ hand-written fast path proposed
after 10.5 lands has to earn its place against the Tier 1/Tier 2 gates from
§2, per the user's explicit framing ("unless it's for very specific and
beneficial reasons") — the gate existing is what makes that a real bar
instead of a vibe.
