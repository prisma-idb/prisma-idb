# Phase 9 — IndexedDB Web API Feature Parity

Stack layer: branches off `main`, lands before Phase 10
([`PLAN_10.0_query_planner_and_benchmarking.md`](PLAN_10.0_query_planner_and_benchmarking.md)).
Source-grounded survey, not yet implementation — mirrors
[`PLAN_8.0`](PLAN_8.0_prisma8_port.md)'s role.

## 0. Why this phase exists

While surveying Phase 10 (the query planner), the planner's own non-goals
list treated missing compound-index support as a ceiling to design around.
The user's correction: that's backwards. Compound indexes
(`createIndex(name, ['a','b'], {...})`) and compound primary keys
(`createObjectStore(name, {keyPath: ['a','b']})`) are native IndexedDB
features — array `keyPath` is standard IDB, not a proposal or a
newer-browser-only capability. Our contract IR not exposing them is _our_
gap, and one instance of it is actively mislabeled in the codebase as a
platform limitation (§1.1). Building more query-planning machinery on top of
a narrower-than-native index surface, then having to redo that machinery
once the surface catches up, is the wrong order. This phase's job: audit
what the actual IndexedDB Web API supports, close the gaps that matter for
real schemas, and leave an explicit, reasoned list of what's deliberately
still deferred — so "feature parity" is a checked box, not a vibe.

Scope boundary: this phase is about whether `family-idb` (contract IR +
PSL/TS-DSL authoring + DDL emission) and `driver-idb` (physical execution)
can _represent and execute_ every native primitive a real schema needs.
Whether `client-idb`'s query planner _uses_ a given primitive well is
Phase 10's job — the two phases are sequenced (this one first) precisely so
Phase 10 designs against the real capability surface instead of a
provisional one.

## 1. Gaps found (verified against the IR/interpreter, not assumed)

### 1.1 Compound primary keys — rejected with a mislabeled error message

`family-idb/src/core/psl-interpreter.ts:315`:

> `Model "X" @@id([...]) declares a compound key. IDB does not support
compound primary keys — use a single @id field instead.`

This is asserted as a platform fact and it's wrong — `IDBObjectStore`'s
`keyPath` option accepts a sequence, so `@@id([a, b])` is directly
expressible as `createObjectStore(name, { keyPath: ['a', 'b'] })`. Today
every Prisma schema using `@@id([...])` (a completely ordinary pattern —
join tables, composite natural keys) either can't target the IDB family at
all, or has to be reshaped to a single synthetic key just for this backend.

Ripple, once the IR allows it: `IdbStoreDefinition.keyPath` (`schema-ir.ts`,
`contract-builder.ts`) needs to become `string | readonly string[]`; DDL
emission (`emission.ts`) needs to serialize an array keyPath; every
key-extraction/key-construction call site in `client-idb`
(`store-accessor.ts`, `mutation-executor.ts`) needs to build a compound key
from multiple fields instead of reading one; `schema-verify.ts`'s store
comparison needs array-aware equality. One piece of this is **already done**:
`client-idb/src/core/types.ts:576`'s `isValidIdbKey` already recurses into
arrays (`Array.isArray(value) ? value.every(isValidIdbKey) : ...`) — the
runtime key-validity check was written compound-key-ready; the block is
entirely at the authoring/IR layer, not the runtime layer. That narrows this
phase's blast radius more than the bug's age might suggest.

### 1.2 Compound secondary indexes — `IdbIndexDef.keyPath` is singular-only

`IdbIndexDef` in both `family-idb/src/core/contract-builder.ts:51` and
`family-idb/src/core/schema-ir.ts:11` declares `keyPath: string`. Native IDB
supports `createIndex(name, ['a', 'b'], { unique })` directly for
`@@unique([a, b])` / `@@index([a, b])`. This is a real gap a real schema hit
(memory: MyFit's schema uses `@@unique([userId, effectiveFrom])` across
three models and can't target this backend as-is). Builds on the same
array-`keyPath` plumbing as §1.1, extended to the index-definition path
(`contract-builder.ts:...329`, `psl-interpreter.ts:...`). Note for Phase 10:
landing this changes what counts as an "indexed" field set for the planner's
multi-field `AND` handling — a compound index becomes a first-class
acceleration target, not just two independent single-field indexes to
possibly intersect (see Phase 10 §3.2).

One explicit non-conflation: `multiEntry` (`contract-builder.ts:53`,
already supported for `Json`-typed array fields) is a _different_ IDB
feature from a compound index — multiEntry explodes one array-valued
field's elements into separate index entries, it doesn't compose multiple
fields into one key. Both are real, both are orthogonal, this phase's
"compound index" work is only about the latter.

### 1.3 Native `count()` / `index.count(range)` never used

Verified by reading the actual lowering, not just the AST kind name:
`store-accessor.ts:861-894`'s `#countTerminal` (the plain `.count()`
terminal) builds the exact same `cursor-scan` plan a `findMany` would via
`#buildScanPlan` (`store-accessor.ts:881`), only overriding the AST's `kind`
to `"count"` for middleware introspection while "the `idbPlan` stays
cursor-scan" (comment at `store-accessor.ts:882`) — then just iterates the
result and increments a counter (`store-accessor.ts:890-893`). Separately,
`aggregate-builder.ts:54`'s `if (fn === "count") return rows.length` handles
`agg.count()` inside `.aggregate(...)`, computing it from an already-fetched
row array rather than a native request. Neither path issues a native
`store.count(range)` / `index.count(range)` request. `IDBObjectStore.count()`/`IDBIndex.count()`
are real, cheap (no value deserialization — count is computed from the
index/store's key structure) native primitives that this client never
constructs a plan for at all. Fixing this is a pure win with no design
risk, and it happens to be exactly the "cheap selectivity oracle" Phase 10's
cost model wants for tie-breaking between candidate indexes (Phase 10 §3.2
tier 3) — landing it here means Phase 10 gets it for free instead of having
to build it as planner-internal plumbing.

### 1.4 Key-only reads (`getAllKeys` / `openKeyCursor`) never used

Every existence-style check goes through a value-materializing `cursor-scan`
today, even when only a key or existence check is needed —
`mutation-executor.ts`'s FK/referential-action lookups
(`buildChildFilterFromRow`, `validateScalarFks`, `findRowByCriterion`,
flagged in `todo.md:14`) deserialize a full row just to answer "does a row
matching this criterion exist." `IDBObjectStore.getAllKeys()` /
`IDBIndex.openKeyCursor()` are native primitives for exactly this and are
unused anywhere in `driver-idb`. This complements, and is distinct from,
Phase 10's job of routing those call sites through an indexed primitive at
all (`todo.md:14`, Phase 10 §4 row 10.5) — this phase makes sure a key-only
primitive _exists_ to route them through; Phase 10 makes sure they get
routed through _some_ indexed primitive instead of a full scan. Either could
technically land without the other, but landing this first means Phase 10's
FK-lookup acceleration is real key-only work from the start, not a
value-scan that happens to also be index-restricted.

### 1.5 What's already in good shape (for calibration — this isn't "everything is broken")

- `autoIncrement` — fully supported (`schema-ir.ts:18`, `psl-interpreter.ts`
  parses `@default(autoincrement())`, `emission.ts:86` serializes it).
- Binary key/value support — `Bytes` has a real codec (`idb/bytes@1`,
  `contract-builder.ts:34`), and `isValidIdbKey`
  (`types.ts:574-575`) already accepts `ArrayBuffer`/`ArrayBufferView`.
- `multiEntry` indexes — supported (`contract-builder.ts:53,188-190`), with
  correct validation (skipped from the field-codec-must-be-key-typed check,
  since a multiEntry index's field holds an array, not a scalar key).
- Transaction modes and lifecycle — `readonly`/`readwrite` used correctly
  throughout; `onblocked`/`onversionchange` handled deliberately
  (`idb-driver.ts:115,133`; `managed-client.ts:104-109` documents _why_
  `onblocked` is a deliberate no-op rather than a missing handler).
- Key-range-restricted cursor scans — `plan-body.ts:71`'s `range: IDBKeyRange`
  already supports `.bound`/`.lowerBound`/`.upperBound`, not just `.only()`
  (this is what makes Phase 10's range-operator acceleration a client-idb-only
  change, per Phase 10 §1.2).

So the gaps are specific and enumerable, not systemic — this phase is a
targeted close-out, not a rewrite.

### 1.6 Implicit auto-commit reliance — investigated on request; no corruption path found, but two real hardening gaps

The user asked specifically about §2's "explicit `transaction.commit()`" deferral: does relying on IDB's implicit
auto-commit hide a subtle correctness bug? Traced the actual mechanism end to end rather than trusting the
in-code comment that asserts it.

**The assumption, and where it's asserted.** `driver-idb/src/core/transaction-scope.ts:11` states: "IDB
auto-commits in a macro-task, not a microtask; each `execute()` issues new requests before the auto-commit
check fires." That claim — a transaction's active flag survives any number of pure-microtask hops and only
lapses once control returns to a macrotask boundary — matches what's commonly written up about modern IDB
behavior, but **this survey did not verify it against the spec text or a cross-browser test matrix**, and it's
the single load-bearing premise of ADR 007's whole "manual path" design. What _is_ independently established:
the pattern is empirically confirmed working today, in Chromium, by two passing Playwright tests
(`multiStoreTransaction.spec.ts`, `referential-actions.spec.ts`) — but `apps/prisma-next-usage/playwright.config.ts:13`
configures exactly one project, `chromium`. No WebKit or Firefox run exists, and WebKit has a documented
history of diverging from Chromium in exactly this area (transaction-lifetime/auto-commit timing bugs).
So the honest status is: verified in Chromium, unverified elsewhere, asserted in a code comment as if it were
a settled cross-browser fact. ADR 005 documents the stricter low-level driver rule (`execute/ops.ts`'s
per-operation executors chain requests via callbacks with zero `await`, ever) — that rule doesn't have this
exposure, since it never crosses a microtask boundary at all. ADR 007's `IdbTransactionScope` sits one layer up
and _does_ rely on the relaxed, macrotask-only assumption — `await scope.execute(...)` sequences are exactly
the "manual path" ADR 007 describes.

**Where this assumption is load-bearing today.** `client-idb/src/core/mutation-scope.ts`'s `withMutationScope`
is the mechanism behind _every_ nested create, cascade delete/update, and referential-action enforcement in
`mutation-executor.ts` — not an opt-in power-user path. Traced every `await scope.execute(...)` call site in
`mutation-executor.ts` (the recursive `applyReferentialActionsForRowOnUpdate`/`applyReferentialActionsForRow`
cascade functions included, `mutation-executor.ts:905-999` and siblings) and found the discipline holds:
sequential `await scope.execute(...)` calls with only synchronous JS between them — loop bookkeeping, filter/
patch construction, recursive calls that thread the _same_ `scope` through (never opening a second, competing
transaction). Default-value resolution (`mutation-defaults.ts`) is fully synchronous — `generateId()`
(`vendor/prisma/packages/1-framework/2-authoring/ids/src/runtime.ts:10`) returns `string`, not a `Promise`,
and no codec `encode`/`decode` in `family-idb`/`client-idb` is `async` (grepped for the pattern; none found).
No `Promise.all`, `setTimeout`, `fetch`, or `crypto.subtle` call sits between any two `scope.execute()` calls
in the mutation path.

**Failure mode, if the assumption is ever violated: loud, not silent.** `executeOpInTx`
(`driver-idb/src/core/execute/ops.ts:44-68`) calls the native IDB method (`store.get`, `store.put`, ...)
synchronously with no `try`/`catch` around it. If the transaction has gone inactive, that call throws
`TransactionInactiveError` _synchronously_ — and since it's called synchronously inside
`IdbTransactionScopeImpl.execute()`'s `new Promise((resolve, reject) => { ... executeOpInTx(...) ... })`
executor (`transaction-scope.ts:85-110`), the thrown exception auto-rejects the returned promise (standard
`Promise` executor semantics). That rejection propagates up through the `await`-chained cascade functions to
`withMutationScope`'s `catch (err) { tx.rollback(); throw err; }` (`mutation-scope.ts:64-66`), which aborts the
transaction and rethrows. Because IDB transactions are atomic, `tx.abort()` reverts _every_ write already
performed on that transaction, including ones that individually succeeded earlier in a cascade — so even a
failure deep into a large cascade rolls back cleanly, all-or-nothing. **No silent-corruption or partial-write
path was found.**

**Two real gaps, both cheap to close:**

1. **The riskiest code path has no real-browser coverage, and "real-browser" today means Chromium only.**
   `fake-indexeddb` (what every `vitest` suite runs under) doesn't model real transaction-lifetime/auto-commit
   timing at all — the same blind spot Phase 10 §2 calls out for performance, applies here for _correctness_.
   The only real-browser coverage of this exact `await`-chained pattern is Chromium-only
   (`apps/prisma-next-usage/playwright.config.ts:13` has a single `chromium` project) via
   `referential-actions.spec.ts` (single-hop `User → Posts`) and `multiStoreTransaction.spec.ts` (2-op manual
   scope) — both pass today, real evidence the mechanism works in Chromium specifically. Two gaps stack here:
   the recursive, multi-hop cascade (`User → Post → Comment`, landed 2026-08-17 per project memory — the
   deepest `await`-chain in the codebase, most exposed to this assumption) has **no real-browser test at all**;
   and even the shallow coverage that exists has never run against WebKit, which has its own history of
   auto-commit-timing divergence from Chromium.
2. **The failure, while loud, isn't self-diagnosing.** A `TransactionInactiveError` reaching `executeOpInTx`
   propagates as a bare native `DOMException` — `execute/error.ts`'s `IdbExecuteErrorCode` union (`STORE_NOT_FOUND`,
   `KEY_GET_FAILED`, `TRANSACTION_ABORTED`, etc.) has no code for it, so it isn't wrapped into the structured
   `IdbExecuteError` every other failure mode gets. A future contributor who adds an innocent `await
someHelper()` inside a cascade function (or, once it ships, a user whose `db.transaction()` callback awaits
   a `fetch`) would see a generic browser DOMException with no hint that "you awaited something that wasn't an
   IDB request between two transaction operations" is the actual cause — exactly the "hard to narrow down from
   client code" failure mode being asked about here.

One more finding while tracing this: **ADR 007's ergonomic "manual path" (`db.transaction(storeNames, async
(tx) => { await tx.users.create(...) })`) isn't wired up to the public client yet.** Only a raw
`transaction(storeNames, async (scope) => { await scope.execute(rawPlanLiteral) })` exists today, reachable
only through `IdbQueryExecutorWithTransaction.transaction()` (used internally by `withMutationScope`) and a
test-only sandbox harness (`multiStoreTransaction.spec.ts`'s `runner.run(...)`) — not through anything a real
app developer imports. That narrows today's actual exposure to the disciplined, audited ORM-internal path
above. But it's a live landmine for whenever that ergonomic API does ship: nothing user-facing today documents
the "only `await` IDB-request-resolving promises inside this callback" constraint — it's only written down in
ADR 005/007, which application developers never read.

**Addressed in Phase 9.5, not deferred** — see §3. This isn't a hypothetical: given how load-bearing
`withMutationScope` already is, and that the next feature this survey adds (compound-key/index cascades, 9.1/
9.2) grows the cascade call chains further, closing the observability gap now is cheaper than debugging an
intermittent production `TransactionInactiveError` with no error code and no real-browser regression test
later.

## 2. Native features knowingly deferred (explicit, not just undiscovered)

- `cursor.continuePrimaryKey(key, primaryKey)` — efficient index+primary-key
  keyset-seeking, useful for true keyset pagination. No current call site
  needs it (today's pagination is `skip`/`take` over a cursor). Revisit if
  Phase 10's benchmark work shows `skip`-heavy pagination is a real cost
  worth a keyset-pagination API, not before.
- `IDBTransaction.durability` hint (`"strict"` / `"relaxed"`) — a
  write-batching latency lever added in a newer IDB revision. No evidence
  today that transaction commit latency is a bottleneck. Revisit only with
  Tier 2 benchmark evidence (Phase 10 §2) showing it matters, since guessing
  a durability policy without measurement is exactly the kind of assumption
  this whole initiative exists to avoid.
- `indexedDB.databases()` enumeration, `navigator.storage.persist()` /
  `.estimate()` — host/browser environment APIs, not query-surface features.
  A contract-driven client already knows its own database name and doesn't
  need to enumerate the origin's databases; storage-pressure APIs are a
  product decision (e.g. surfacing a "storage almost full" UI), not a
  parity gap.
- Explicit `transaction.commit()` (vs. relying on IDB's implicit
  auto-commit). Investigated properly, not assumed — see §1.6: the
  implicit-commit reliance itself checks out (no silent-corruption path
  found, and the exact `await`-chained pattern has real-browser test
  coverage today). Adding an explicit `commit()` call wouldn't change that
  — it's deferred as a driver API addition. What _isn't_ deferred is
  closing the two hardening gaps §1.6 found (untested deep-cascade path,
  non-diagnosable failure mode) — that's Phase 9.5.

## 3. Phase stack

| Phase | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Depends on |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 9.1   | **Implemented**, reconciling onto `main` after Phase 8 (Prisma 8 port + `@prisma-idb` rename, PR #229) landed first. Compound primary keys: remove the mislabeled rejection in `psl-interpreter.ts:315` (and the equivalent TS-DSL authoring path), lower `@@id([...])` to an array `keyPath`; `IdbStoreDefinition.keyPath` → `string \| readonly string[]` across `schema-ir.ts`/`contract-builder.ts`; DDL emission (`createObjectStore(name, {keyPath: [...]})`); `schema-verify.ts` array-aware comparison; key extraction/construction in `store-accessor.ts`/`mutation-executor.ts`; verify compound-keyed relations (FK local/foreign field lists) work symmetrically on the referenced side. Differential tests: full create/read/update/delete/cascade against a real compound-PK model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —          |
| 9.2   | **Implemented**, reconciling onto `main` alongside 9.1. Compound secondary indexes: same array-`keyPath` plumbing extended to `@@unique([...])`/`@@index([...])`; `createIndex(name, [...], {unique})` DDL emission; `schema-verify.ts` index comparison. Explicit test that `multiEntry` and compound-index paths don't get conflated (§1.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 9.1        |
| 9.3   | Native `count()`/`index.count(range)`: new `IdbCountPlan` (`kind: "count"`) in `plan-body.ts` calling `store.count(range)`/`index.count(range)` directly; wire the ORM `.count()` terminal (`aggregate-builder.ts`) to it instead of `rows.length` over a materialized array                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —          |
| 9.4   | Key-only reads: new key-only cursor / `getAllKeys` physical plan; route `mutation-executor.ts`'s existence-only FK lookups (`validateScalarFks`, `findRowByCriterion`, `buildChildFilterFromRow` where only existence/keys are needed) through it instead of a value-materializing `cursor-scan`. Sequenced after 9.1, not independent — 9.1 rewrites the same file's key extraction/construction for compound primary keys, and 9.4 edits the same call sites' read path; land 9.1 first to avoid two phases touching `mutation-executor.ts` out of order. Sets up, but does not itself complete, `todo.md:14` (Phase 10 §4 row 10.5 finishes the job by making those call sites actually choose an indexed plan)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 9.1        |
| 9.5   | Harden the implicit-auto-commit reliance found in §1.6: (a) add a new `TRANSACTION_INACTIVE` `IdbExecuteErrorCode` and wrap the synchronous `TransactionInactiveError`/`InvalidStateError` DOMException at the `executeOpInTx`/`scope.execute()` boundary with an actionable message pointing at the ADR 005/007 rule, instead of letting a bare native `DOMException` surface; (b) add a real-browser (Playwright, `apps/prisma-next-usage`) test exercising a multi-hop cascade (3+ levels — `User → Post → Comment`-shaped) and a wide-fanout cascade, explicitly framed as pinning the transaction-lifetime assumption rather than as a feature test — must assert the rollback half too (trigger a failure partway through the deep cascade, confirm zero partial writes committed), and must add a WebKit Playwright project (`apps/prisma-next-usage/playwright.config.ts` is Chromium-only today) so the guarantee is established per-browser instead of re-confirmed in the one browser already known to work; (c) once the ADR-007 ergonomic `db.transaction()` API is wired to the public client (tracked separately, not this phase), its JSDoc must carry the same "only `await` IDB-request-resolving promises here" warning with a good/bad example, mirroring ADR 005's | —          |
| 9.6   | ADR (next free number in `packages/prisma-orm/docs/adrs/` at authoring time — 017 as of this survey, since ADR 016 is still "Proposed, pending review, not implemented" per `todo.md:10`; re-check before writing) documenting the audited native-feature checklist from §1/§2: what's supported, what's deliberately deferred and why, plus 9.5's hardening work. Update `todo.md`'s "IDB has no compound-index support" note (now stale) and close the MyFit-schema-blocking finding from memory. Written last, over settled ground                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 9.1–9.5    |

## 4. Non-goals

- Anything in `packages/generator` (the old codegen) — scoped to
  `packages/prisma-orm`.
- Maximal Web API mirroring for its own sake. The target is "features a real
  Prisma schema needs and our own authoring surface can express," not every
  conceivable IndexedDB primitive — see §2 for what's deliberately deferred
  and why, so a future contributor finds a reasoned decision instead of an
  unexplained absence.
- The query planner itself (which physical plan to _choose_ for a given
  filter) — that's Phase 10, which depends on this phase's output.
