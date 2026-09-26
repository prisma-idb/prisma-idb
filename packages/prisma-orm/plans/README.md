# Phase 10 — Benchmarking foundation + IDB query planner

[`PLAN_10.0_query_planner_and_benchmarking.md`](PLAN_10.0_query_planner_and_benchmarking.md)
is a source-grounded survey (not yet implementation) of building a real
benchmark gate for `client-idb` (mirroring `apps/benchmark`'s CI-gate rigor
for the old generator) as the prerequisite for replacing
`query-shaping.ts`'s hand-written index-acceleration heuristics with a real
query planner — closing `todo.md`'s range-operator, OR-extraction, and
`mutation-executor.ts` FK-lookup follow-ups. Read its §2 ("What 'measurable'
means here") before starting any phase past 10.1 — it sets the two-tier
gate (deterministic plan-shape assertions vs. advisory wall-clock) that
every later phase's acceptance criteria depend on. **Depends on Phase 9**
(below) — an earlier draft of this survey treated missing compound-index
support as a design constraint to work around; the user's call was that
compound indexes are a native IndexedDB feature our contract IR should just
expose, scoped out as its own phase first, so the planner is designed
against the real capability surface instead of a provisional one. Branches
off `main` after Phase 9 lands, as `feat/query-planner`. Implementation
lands as a stack of PRs (§4 of that doc); each phase gets its own
`PLAN_10.x_*.md` once it starts.

| Phase | Goal                                                                                                                                                                                                                                                              | Depends on    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 10.1  | Extract `stats`/`config-validation`/comparison-script logic out of `apps/benchmark` into a shared `benchmark-kit` package, zero behavior change                                                                                                                   | —             |
| 10.2  | New `apps/prisma-next-benchmark`, schema/ops designed backwards from the planner's target cases (now including a real compound-indexed case); pre-planner baseline captured and committed                                                                         | 10.1, Phase 9 |
| 10.3  | Node/vitest hard-blocking gate asserting plan-kind + bounded records-examined per query pattern, extending the `store-accessor.ts:882` middleware-introspection seam; must be green on current `main` behavior before 10.4 starts                                 | Phase 9       |
| 10.4  | The planner: pure filter-AST+index-metadata → `IdbPlanBody` function replacing `extractIndexEqualityHint`/`extractIndexOrHint`; range acceleration, correct per-branch OR, tiered `AND` strategy now backed by real compound indexes, real `index-get` use        | 10.2, 10.3    |
| 10.5  | Wire planner into `store-accessor.ts` + extract shared index-hint primitive for `mutation-executor.ts`'s FK lookups (building on Phase 9.4's key-only-read primitive); delete `query-shaping.ts`'s old heuristics; confirm non-regression against 10.2's baseline | 10.4          |
| 10.6  | ADR (next free number at authoring time — expected 018, one after Phase 9.6's ADR; re-check) documenting the logical/physical plan split and the tiered cost model; close `todo.md:12/13/14`                                                                      | 10.5          |
