# Phase 9.3 — Native `count()` / `index.count(range)`

Status: **implemented, uncommitted** (see §8 for what shipped and how it deviated). Forward plan, following `PLAN_9.0_idb_web_api_feature_parity.md`
§1.3 / §3 (row 9.3). This doc corrects and narrows that row using a re-read of
the actual call sites — the one-line phase-table entry ("wire the ORM `.count()`
terminal _and_ `agg.count()`") overstates what can go native.

Depends on: nothing (9.1/9.2 have landed; this phase doesn't touch keys).
Unblocks: Phase 9.4 (reuses the result-row decision in §2), Phase 10.4's
cost model (a cheap selectivity oracle).

## 1. Findings (verified against the code, not the survey)

### 1.1 `#countTerminal` has three paths; only two can ever go native

`store-accessor.ts` `#countTerminal` (the plain `.count()` terminal):

| Path                   | Today                                                                                                 | Can it use native `count`?                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OR multi-scan          | `extractIndexOrHint` → `#executeOrRows` → dedupe by primary key → `rows.length`, then skip/take clamp | **No.** A per-branch `count()` double-counts a row matching two branches, and dedup needs the actual keys. Not a 9.3 goal (see §5).                                                                                |
| Indexed equality       | `#buildScanPlan` → `cursor-scan` with `range: IDBKeyRange.only(v)`, then iterates and increments      | **Only if `remainingFilter` is undefined.** A residual in-memory filter needs row values.                                                                                                                          |
| Full scan / no `where` | `cursor-scan` over the whole store, iterates and increments                                           | **Only if there is no in-memory `filter`.** With no `where` at all (`db.orm.todos.count()`) this is the biggest win: today it deserializes every row just to count them; native `store.count()` deserializes none. |

So the qualifying predicate is exactly: **the built `cursor-scan` plan has no
in-memory `filter`.** `comparator` (ORDER BY) and `direction` don't change a
count, so they must be _ignored_, not treated as disqualifying — a
`.orderBy(...).count()` should still go native. Name this as one helper
(`isNativelyCountable(plan)` or equivalent) so 10.4's planner can reuse it.

### 1.2 `skip` / `take` must be applied after the native result

Native `count(range)` returns the _unpaginated_ total. The clamp
`n = max(0, n - skip); n = min(take, n)` already exists in the OR branch of
`#countTerminal`; it must apply to the native path too, explicitly, after the
plan runs. `take: 0` → `0`. Paginated count is arithmetic on the unpaginated
count, so this is exact (not an approximation).

### 1.3 There are three "count" sites — this phase covers one

1. **`.count()` terminal** (above) — **in scope.**
2. **`aggregate-builder.ts` `reduceAggregate`** (`if (fn === "count") return rows.length`) — reduces over rows `#materialize` already fetched. `.aggregate()` can request `count` _alongside_ `sum`/`avg`/`min`/`max`, which needs the rows regardless, so native count buys nothing there. Native helps only when `count` is the **sole** selector. **In scope only as an optional follow-on task (§4, task 6)**; if skipped, record it as deliberately deferred.
3. **`relation-loader.ts` per-parent `include('rel', r => r.count())`** (scalar reducer, ~line 177) — one count per parent row, currently derived from fetched children. Doing this natively means a `count(only(fk))` per parent and only pays off when the FK is indexed. **Deferred to Phase 10.5** (same "resolve equality against the index map" primitive). Named here so it doesn't read as an oversight.

### 1.4 Correctness: when does `index.count(range)` equal `rows.length`?

Native `count` counts _index entries_ in the range, not records. It matches
`findMany(...).length` when:

- The index is **not** `multiEntry` (one record can occupy several entries).
  `buildFieldToIndexMap` already excludes multi-entry and compound indexes, and
  the equality hint goes through that map, so this holds by construction.
- The range came from a single `eq` on a valid key (`isIndexableEqValue`), so
  `IDBKeyRange.only` cannot throw.
- Records lacking a valid value for the indexed field are absent from the index
  — but such a record can't satisfy `field eq <valid key>` either, so the counts
  agree.

Because `findMany` already trusts IDB key equality for the same range (via the
same hint), `count()` and `findMany().length` stay consistent _by construction_.
The differential test (§6) asserts this rather than assuming it; the risky value
types are `Date` and `Bytes` (IDB compares by value, JS `===` does not — confirm
`evaluateFilter`'s `eq` agrees).

## 2. Decision: how a count travels through a `Row[]` driver (shared with 9.4)

The driver contract is `Promise<Row[]>` end to end — `executeIdbPlan`,
`IdbTransactionScope.execute`, `executeOpInTx`'s `onComplete`, and the
accumulate-then-`tx.oncomplete` pipeline (`execute/index.ts`). A count's natural
result is a number. Two options:

- **A. Synthetic single row (chosen):** the plan yields `[{ count: n }]`; the
  caller unwraps `rows[0].count`. **Zero plumbing change** — no signature
  widens, both middleware chains and the transaction scope are untouched, and
  ADR 006's collect-then-yield contract stays literally true (one small row).
- **B. Widen the result type** (`Row[] | number | …`): touches every `execute`
  call site, `IdbTransactionScope`, `AsyncIterableResult` plumbing, and both
  middleware chains. Rejected: cross-cutting for a cosmetic gain.

Phase 9.4 adopts the same convention (`[{ key }]` / `[]`) and references this
section. Add one paragraph to the Phase 9.6 ADR recording it.

## 3. Design

### 3.1 New plan kind

`driver-idb/src/core/plan-body.ts`:

```ts
export interface IdbCountPlan extends ExecutionPlan {
  readonly kind: "count";
  readonly storeName: string;
  readonly indexName?: string; // count via this index instead of the store
  readonly range?: IDBKeyRange; // omit = count every entry
}
```

Add to the `IdbAtomicPlan` union. Result: exactly one row, `{ count: number }`.

### 3.2 Executor

`execute/ops.ts`: `execCount` — `(indexName ? store.index(indexName) : store).count(range)`
(pass `range` only when defined; `count(undefined)` counts all). `onsuccess` →
`onComplete([{ count: req.result }])`. `onerror` → new `IdbExecuteErrorCode`
`"COUNT_FAILED"` (the enum is per-op, so a code is required).

### 3.3 Client wiring

`store-accessor.ts` `#countTerminal`, after the OR branch: build the scan plan as
today; if `isNativelyCountable(scanPlan.idbPlan)`, replace it with an
`IdbCountPlan` carrying the same `storeName`/`indexName`/`range`, execute it,
unwrap `count`, then apply the skip/take clamp (§1.2). Otherwise fall through to
today's iterate-and-increment. Keep `ast: IdbCountAst` (already exists at
`adapter-idb/src/core/idb-query-ast.ts`) so middleware still sees `kind: "count"`.

**The comment at `store-accessor.ts` ("Override the AST kind for middleware
introspection — the idbPlan stays cursor-scan") becomes false and must be
rewritten.** Visible consequence for Phase 10.3: a plan-shape assertion that
would have seen `cursor-scan` for `.count()` now sees `count`.

## 4. Work items — the full ripple of adding an `IdbAtomicPlan` member

The ripple is identical for 9.4's new kind; enumerate it here once.

- [x] **1.** `driver-idb/src/core/plan-body.ts` — `IdbCountPlan` + union member.
- [x] **2.** `driver-idb/src/core/execute/ops.ts` — `execCount`; add the `case` to `executeOpInTx`'s switch (it has **no `default`**, so `tsc` flags a missing case).
- [x] **3.** `driver-idb/src/core/execute/error.ts` — add `"COUNT_FAILED"`.
- [x] **4.** **`sync-extension-idb/src/core/sync-executor.ts`** — the interception switch ends in `const _exhaustive: never = plan;`. A new `IdbAtomicPlan` member **breaks that package's typecheck** until `"count"` joins the untracked-reads case list (`put` / `key-get` / `index-get` / `cursor-scan`). Cross-package, and absent from PLAN_9.0.
- [x] **5.** `client-idb` — `isNativelyCountable`, the `#countTerminal` change, the stale comment (§3.3).
- [x] **6.** _(optional; done)_ `.aggregate()` with `count` as the sole selector routes through the same plan. If skipped, note "deferred: mixed selectors need rows anyway" in the PR.
- [x] **7.** No change needed — say so in the PR so reviewers don't hunt: `planTxMode` (`execute/ops.ts`) and the batch-mode check (`execute/index.ts`) allowlist _write_ kinds and fall through to `readonly`, which is correct for `count`. The adapter is a passthrough (`lower()` returns `plan.idbPlan`), and `IdbCountAst` already exists.
- [x] **8.** `getKeyPath` now throws (rather than falling back to `"id"`) when a model has no `keyPath`; the count path calls it (via `#buildScanPlan`), so it inherits that failure mode. No action, just don't be surprised by the error in a malformed-contract test.

## 5. Non-goals

- OR-branch counting (double-count hazard, §1.1). Forward pointer: a key-only per-branch scan from Phase 9.4 could dedupe keys without materializing rows and fix this properly — a 9.4/10.x follow-up, not a 9.3 commitment.
- Counting through a residual in-memory filter (needs row values).
- Range-operator (`gt`/`lt`) counts — need the Phase 10 planner to produce the range.
- Per-parent `include(...).count()` (Phase 10.5, §1.3).
- Any change to `groupBy` (needs rows for grouping).

## 6. Test plan

**Driver (`driver-idb/test/execute.test.ts` pattern):** `count` on a store; on an index; with `only` and `bound` ranges; empty store → `[{count: 0}]`; nonexistent store → `STORE_NOT_FOUND`; nonexistent index → rejects (same synchronous `NotFoundError` as `index-get`; `COUNT_FAILED` is for request-level failures); runs inside a `batch` and inside a transaction scope without disturbing later ops.

**Client (fake-indexeddb, `client-idb/test/`):**

- Differential: for a fixed dataset, `count()` equals `findMany().length` across — no `where`; `eq` on PK; `eq` on a single-field index; `eq` on an unindexed field (fallback); `eq` + extra field (residual filter → fallback); `skip`; `take`; `skip`+`take`; `take: 0`; `skip` beyond total; `orderBy` present (must still go native).
- Plan-shape: a recording executor/middleware asserts `idbPlan.kind === "count"` for the native cases and `"cursor-scan"` for fallbacks (OR, residual filter). This is the regression guard against silently losing the fast path.
- Value edges: `Date` and `Bytes` equality on an indexed field (§1.4); an invalid key value (`boolean`, `NaN`) falls back rather than throwing `DataError`; nullable indexed field.
- Compound-keyed model (9.1): `eq` on _one_ member of a compound PK must **not** be treated as a PK range (`isPrimaryKeyField` is false for array keyPaths) — count still correct via fallback.
- `multiEntry` index present on the model: count unaffected (not selected by the hint).
- Inside a `transaction()` scope (nested-write model) and via the sync-intercepting executor: `count` is untracked, produces no outbox rows.

**Gates (all must be green):** `pnpm --filter @prisma-idb/driver-idb test`, `@prisma-idb/client-idb test`, `@prisma-idb/sync-extension-idb test`, and — because item 4 is a cross-package type break — **`turbo run check` across every `packages/prisma-orm/*` package**, not just the ones edited. A green vitest with an unrun `tsc` is meaningless here.

## 7. Risks / open questions

- **fake-indexeddb parity.** `docs/FEEDBACK.md` already flags CI-invisible browser divergences. `IDBObjectStore.count`/`IDBIndex.count` are old, stable IDB 1.0 APIs, so the risk is low — but add one real-browser (Playwright, `apps/prisma-orm-usage`) assertion that a native count matches a materialized one, if the existing Playwright project makes that cheap.
- **Semantics drift on `Date`/`Bytes` equality** (§1.4) — resolved by the differential test, not by argument.
- **Performance claims.** Don't assert numbers in the PR; Phase 10.2's benchmark app is the place to measure. (Native count over a large range is still linear in entries inside the engine, just without deserialization.)

## 8. What shipped (post-implementation notes)

Everything in §4 landed, including the optional `.aggregate()` fast path.

- **Files:** `driver-idb` (`plan-body.ts`, `execute/ops.ts`, `execute/error.ts`, `exports/runtime.ts`), `client-idb` (`query-shaping.ts` — `isNativelyCountable`/`toCountPlan`/`clampCount`; `store-accessor.ts` — `#countTerminal`, `aggregate()`, shared `#executeNativeCount`), `sync-extension-idb` (`sync-executor.ts` untracked-reads case; test helper type).
- **Deviation 1 — unknown index:** an unknown `indexName` rejects with the raw `NotFoundError` (like `index-get`), not `COUNT_FAILED`; §6's driver test was corrected accordingly.
- **Deviation 2 — `aggregate()` reuses `#buildScanPlan`:** `aggregate()` previously never used index acceleration (`#materialize` is a bare full scan). The count-only fast path goes through `#buildScanPlan`, so `where({ indexed: v }).aggregate(count)` is now index-accelerated too — a small, intentional widening. `aggregate()` still ignores `skip`/`take`, as before.
- **Verified the tests can fail:** temporarily making `isNativelyCountable` always `true`, dropping the skip/take clamp, and breaking the OR path each fail the new suite; removing the `"count"` case from `sync-executor.ts` fails `tsc` (`IdbCountPlan` not assignable to `never`) — the cross-package break §4 item 4 predicted.
- **Gates run:** `turbo run check test lint` across every `packages/prisma-orm/*` package (35/35), plus `check` on both `apps/prisma-orm-*`.
- **Not done (by design, per §5):** OR-branch counts, residual-filter counts, range-operator counts, per-parent `include().count()` (Phase 10.5), real-browser Playwright parity check (§7 — optional, left as a follow-up).
- **Stale comment fixed:** `#countTerminal`'s "the idbPlan stays cursor-scan" note is gone. Phase 10.3's plan-shape assertions must now expect `count` for natively-countable `.count()` calls.
