## Status

_Last updated: 2026-06-04 — **pre-presentation review pass** ([§ Audit 2026-06-04](#audit-2026-06-04--pre-presentation-review)). Fresh fatal-flaw sweep against the vendor reference + `FEEDBACK.md` ahead of presenting to Prisma's engineers. Found and fixed one genuine fatal flaw — the two-phase marker write could wedge a database permanently after a crash because `applyOneDdlOp` was not idempotent, and **ADR 002 documented a false "IDB guarantees idempotency" claim** ([Issue #25], now fixed + ADR corrected). Also closed the recursive-nested-write `DataCloneError` footgun ([Issue #22]). All migration apply paths now replay-safe. A **follow-up cleanup pass** then closed the entire remaining issue ledger except Phase 8 outbox: deleted the dead nested-write AST nodes ([Issue #21]), made `upsert` atomic + child-owned `connect` match-all ([Issue #24]), added the `openAndUpgrade` `onblocked` handler, and removed a dead import. The only item left open is the framework-SPI-blocked `introspect`/`readMarker` "lying refusals" (needs an upstream `unsupported` discriminator). **Verification: 393 vitest passing (369 across the 6 packages + 24 CLI e2e; +5 regression tests this pass — target-idb 81, client-idb 102) + 93 Playwright; all changed packages `tsc --noEmit` clean.** (The CLI e2e suite count was corrected 20 → 24 — the earlier figure in the table below was stale.) No other fatal flaws found: the architecture is faithful to the framework and FEEDBACK §1–8 remain fully addressed._

_Prior context (2026-06-04 — **v0.12.0 migration complete**) (all 7 idb packages + demo app updated to `@prisma-next/*@0.12.0`). Major breaking changes: `Contract.models` removed (models live under `domain.namespaces.<ns>.models`; `contractModels()` helper added), `relation.to` changed from `string` to `CrossReference { namespace, model }`, `StorageBase` now requires `namespaces`, `MigrationRunner` SPI merged `MultiSpaceCapableRunner` into a single `execute({driver, perSpaceOptions})`, `RuntimeMiddlewareContext` gained `planExecutionId`. Demo contract re-emitted, old migration dirs replaced with a fresh baseline, `contract-space.generated.ts` regenerated. Verification: **477/477 tests passing (384 vitest + 93 Playwright)**, all packages `tsc --noEmit` clean._

_Prior context (2026-06-02 — **Phases 6.5, 6.6, and 6.7 shipped**): Include refinement, aggregate/groupBy, select projection, completing the Phase 6 ORM lane. While wiring the demo Playwright specs this pass also found and FIXED a pre-existing browser-only crash: the Phase-7 / Issue #23 integrity check imported `computeMigrationHash` from `@prisma-next/migration-tools/hash`, which uses `node:crypto` and threw `createHash is not a function` on every browser client init — breaking the entire demo app. Replaced with a byte-identical WebCrypto implementation ([§ Phase 6.5–6.7](#phase-65-67-include-refinement-aggregate-select-2026-06-02))._

_Prior context (2026-05-29 third-pass audit): Phase 7 (migration package layer rewrite, 2026-05-27) addressed Group A + B of [`FEEDBACK.md`](FEEDBACK.md); the 2026-05-28 pass cleaned up the residual Phase-7 bugs; the 2026-05-29 pass found and FIXED a build-breaking type-gate regression in Phase 6.4 ([Issue #20]). Remaining open items are four lower-priority faithfulness/robustness gaps ([Issue #21], [Issue #22], [Issue #24], [Issue #25]) and outbox sync. See [§ Audit 2026-05-29](#audit-2026-05-29)._

| Phase | Description                                                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Codec system (`target-idb`)                                                                       | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2     | Runtime driver (`driver-idb`)                                                                     | ✅ Done — Issue #11 (batch-with-update tx mode) fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3     | Query lowering (`adapter-idb`)                                                                    | ✅ Done (passthrough; per-field codec encoding deferred — all codecs identity); Issue #13 (descriptor `.create()` codec wiring) fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4     | Control plane manifest operations (`family-idb`)                                                  | 🪦 Superseded by Phase 7 — manifest deleted, CLI returns `IDB-CLI-UNSUPPORTED` envelopes; the layer that survives is `schema-verify` (pure) + `deserializeContract` (pure)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5     | Migration infrastructure (`target-idb/control`)                                                   | ✅ Done — planner + DDL ops + schema diff + 4-file package layout; runner's `executeAcrossSpaces` returns refusal envelope (Phase 7.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6     | IDB ORM lane (`client-idb`) + runtime (`runtime-idb`)                                             | ✅ Done — phases 6.1–6.7 shipped (6.5–6.7 landed 2026-06-02; see [§ Phase 6.5–6.7](#phase-65-67-include-refinement-aggregate-select-2026-06-02))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6.1   | Filter expression AST + operator API                                                              | ✅ Done — `IdbFilterExpr` + evaluator + `IdbModelAccessor` proxy + `and/or/not`; shorthand `null` lifts to null-check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6.2   | Missing CRUD terminals (update, upsert, createAll/Count, deleteAll/Count, updateAll/Count, count) | ✅ Done — vendor naming adopted; `IdbScanWritePlan` + `IdbBatchPlan` driver primitives; 9 new ORM methods; known gap: `.where()` enforcement not compile-time-checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6.3   | Multi-store transaction support                                                                   | ✅ Done — `IdbTransactionScope` + `createTransactionScope` in driver; `withMutationScope` + `IdbQueryExecutorWithTransaction` in client; `IdbRuntime.transaction()` wired; Issue #6 resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6.4   | Nested relation writes (create/connect/disconnect)                                                | ✅ Done — `IdbRelationMutator` + `mutation-executor.ts` + `relation-mutator.ts`; `create()`/`update()` detect callbacks and open multi-store transactions; FK validation in `connect()`. 14 vitest + 3 Playwright spec files green; `tsc --noEmit` now clean ([Issue #20] fixed 2026-05-29). Still uncommitted at audit time. Scalar FK validation + full referential action enforcement on delete completed in Phase 6.8.                                                                                                                                                                                                                                                                        |
| 6.5   | Include refinement (where/orderBy/take inside include)                                            | ✅ Done (2026-06-02) — `include(rel, refineFn)`; refined child accessor builds `IncludeEntry`; per-parent orderBy/skip/take + refined where in `relation-loader`; scalar `count()` via refinement-mode `count()` → `IdbIncludeScalar`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6.6   | Aggregate / groupBy                                                                               | ✅ Done (2026-06-02) — `aggregate-builder.ts` (count/sum/avg/min/max + in-memory reducer) + `grouped-accessor.ts`; standalone `.aggregate()` + `.groupBy(...).aggregate()`; `IdbAggregateAst` / `IdbGroupByAst` attached to the materialising scan                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6.7   | Select projection                                                                                 | ✅ Done (2026-06-02) — `select(...)` adds `TSelected` type param + `selectedFields` state; projection runs after relation loads (FK fields survive includes); `SelectedRow` narrows the row type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6.8   | FK validation + referential action enforcement                                                    | ✅ Done (2026-06-11) — `IdbReferentialAction`/`IdbRelationStorage` in `target-idb`; `onDelete?` on `RelationDef` in `family-idb`; scalar FK existence check on `create`/`update` when N:1 localFields are present; `cascade`/`setNull`/`restrict`/`noAction` on `delete`/`deleteAll` via `withMutationScope`; `1:1` parent-side enforcement included. `setDefault` originally threw at runtime (IDB contracts didn't track field defaults) — since closed, see "`setDefault` referential action, recursive cascade, and `onUpdate` — done" below. 22 new vitest + 8 new Playwright specs. See [ADR 009](docs/adrs/ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md). |
| 7     | Migration package layer rewrite (Group A + B feedback)                                            | ✅ Done — see [plans/](plans/) for the 8 per-phase docs (7.1–7.8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7.1   | Foundation: `IdbMigration` base + `MigrationCLI` shim                                             | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.2   | Planner refit: class-based `migration.ts` scaffold                                                | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.3   | Runner refit + manifest demolition + control-instance refusal                                     | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.4   | Browser runtime refit: walk `contractSpace.migrations`; safe policy; `versionchange`              | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.5   | ContractSpace codegen (`prisma-idb migration contract-space`)                                     | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.6   | Migration preflight (`prisma-idb migration preflight`)                                            | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.7   | Migrate `apps/prisma-orm-usage`                                                                   | ✅ Done in code; **stale `prisma.config.ts` driver ref + leftover `prisma-idb.manifest.json` cleaned up in audit 2026-05-28** ([Issue #17])                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7.8   | Cleanups closure + memory + this status                                                           | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8     | Outbox sync                                                                                       | ❌ Not started (was Phase 7 in older docs; renumbered after the migration-rewrite landed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Test status (run 2026-06-04, after v0.12.0 migration)

| Package                   | Tests pass | Tests fail | Notes                                                                                                                           |
| ------------------------- | ---------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------- |
| `target-idb`              |         81 |          0 | +2 crash-recovery replay tests (Issue #25); runner tests consolidated for new `execute({driver, perSpaceOptions})` SPI          |
| `driver-idb`              |         57 |          0 | unchanged                                                                                                                       |
| `adapter-idb`             |         29 |          0 | unchanged                                                                                                                       |
| `runtime-idb`             |         21 |          0 | `planExecutionId` added to mock `customCtx` fixtures                                                                            |
| `client-idb`              |        124 |          0 | +22 Phase 6.8 (11 scalar FK validation + 11 delete enforcement); prior: +3 Phase 6.4 fixes, +19 Phase 6.5–6.7                   |
| `family-idb`              |         79 |          0 | `createRawIdbContract` replaces removed `@prisma-next/contract/testing`; raw contracts updated                                  |
| `prisma-idb-cli` (tests/) |         24 |          0 | end-to-end CLI surface tests for `generate-baseline` / `generate-contract-space` / `preflight`                                  |
| `prisma-idb-usage`        |        101 |          0 | +8 Phase 6.8 Playwright specs (cascade delete, scalar FK validation); demo contract gains `onDelete: "cascade"` on `User.posts` |

**Total: 508/508 tests passing (415 vitest + 93 Playwright) — pending Playwright run for Phase 6.8 (+8).**

### `setDefault` referential action, recursive cascade, and `onUpdate` — done

`setDefault`, multi-hop recursive cascade, and `onUpdate` referential actions (previously tracked as follow-ups here) are implemented — see [ADR 009](docs/adrs/ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)'s Consequences section for the shipped design. `IdbModelStorage.fieldDefaults?: Record<string, string | number | boolean>` backs `setDefault`, populated only from literal `@default(...)` values.

[Issue #1]: #issue-1--migrationrunner-missing-executeacrossspaces-blocks-cli-db-update
[Issue #2]: #issue-2--sign-does-not-populate-manifestschema-from-contract
[Issue #4]: #issue-4--missing-stores-treated-as-warnings-in-lenient-schema-verify
[Issue #17]: #issue-17--demo-app-config-references-deleted-idbmanifestcontroldriverdescriptor
[Issue #18]: #issue-18--definecontract-emits-empty-capabilities-diverging-from-prisma-next-contract-emit
[Issue #19]: #issue-19--runtime-idb-mock-driver-missing-transaction-method-fails-tsc-noemit
[Issue #20]: #issue-20--client-idb-fails-tsc---noemit-after-phase-64-build-gate-red
[Issue #21]: #issue-21--nested-write-ast-nodes-are-dead-code
[Issue #22]: #issue-22--recursive-nested-writes-throw-a-cryptic-datacloneerror
[Issue #23]: #issue-23--no-apply-time-integrity-check-against-migrationhash
[Issue #24]: #issue-24--upsert-is-non-atomic-and-child-owned-connect-diverges-from-vendor
[Issue #25]: #issue-25--two-phase-marker-write-has-no-crash-recovery-guard

---

## Audit 2026-06-04 — pre-presentation review

Fifth-pass review, ahead of presenting the IDB packages to Prisma's engineers. Goal: a fresh fatal-flaw / bug / un-implemented-code sweep across all six packages (excluding Phase 8 outbox, which is intentionally unstarted), cross-checked against the cloned vendor reference (`vendor/prisma-next/`), the ADRs, and `FEEDBACK.md`. Method: re-read the full migration apply path (browser `auto-migrate` → shared `apply-ddl-op` → CLI `preflight`), the nested-write executor against the vendor's `sql-orm-client/mutation-executor.ts`, the driver transaction-liveness model, the `migrationHash` write/verify symmetry across the Node/WebCrypto boundary, the family-idb codegen, and the demo app's generated artefacts; ran every package's `vitest` + `tsc --noEmit`.

### 🔴 Fatal flaw found and fixed — non-idempotent DDL apply could wedge a DB permanently

The single material finding. `applyOneDdlOp` applied each DDL op unconditionally (`db.createObjectStore(...)`, `store.createIndex(...)`). Combined with the two-phase marker write (ADR 002 — marker `put` happens in a separate tx _after_ the version-change tx commits), this created a permanent-wedge failure mode:

1. A tab is killed in the window between the upgrade committing and the marker `put` landing → schema is at the new version, marker still reads the old `storageHash`.
2. Next open: `walkChain` reads the stale marker and re-collects the **already-applied** ops; `openAndUpgrade` reopens at `version + 1` and replays them.
3. `createObjectStore` on the existing store throws `ConstraintError` → the version-change transaction aborts → the open request errors → **every subsequent open repeats this and fails identically forever.**

This was tracked as a 🟢 "tradeoff" ([Issue #25]) but is a genuine fatal flaw, made worse because **ADR 002 documented a _false_ safety guarantee** — it claimed DDL ops are "idempotent under 'store already exists' semantics (IDB's own guarantee)". IndexedDB provides no such guarantee. A Prisma engineer reading ADR 002 against the spec would have flagged this immediately.

**Fix.** `applyOneDdlOp` is now explicitly idempotent — each op guards on an existence check (`objectStoreNames.contains` / `indexNames.contains`, and the inverse for drops). Replaying an already-applied op is a no-op, so the recovery run ADR 002 describes now actually works. Because all three apply paths (browser auto-migrate, CLI runner, preflight) share this one function, the fix lands everywhere at once. ADR 002's false claim + failure-mode table were corrected. Regression: two `target-idb` tests replay the full op set (and a drop set) at a bumped version against `fake-indexeddb` and assert no throw.

### 🟡 Footgun closed — recursive nested write `DataCloneError`

[Issue #22]: nesting a relation callback inside an already-nested record passed a function to `store.put(...)`, surfacing IDB's opaque `DataCloneError`. `insertSingleRow` now guards with `assertNoNestedCallbacks` and throws a precise "recursive nested writes are not supported" message. Regression test added. (Important for the live demo — an opaque structured-clone error mid-presentation would read as a framework bug.)

### ✅ Confirmed-good (re-verified this pass)

- **`migrationHash` write/verify symmetry is sound across the Node↔browser boundary.** `generate-baseline` (and `migration plan`) write the hash via the framework's `@prisma-next/migration-tools/hash` (`node:crypto`); the browser verifies via the WebCrypto re-implementation in `client-idb/src/core/migration-hash.ts`. Read both line-by-line: identical canonicalization (`canonicalizeJson`), identical nested SHA-256/hex scheme, identical `migrationHash`-only strip, identical `sha256:` prefix. `auto-migrate-evolution.test.ts` (real fixture hashes) is the live guard.
- **The demo app's generated `contract-space.generated.ts` + on-disk migration packages are current and chain-consistent** (baseline `from: null` with the marker store as op 0, then the `posts` migration; head ref derived from the last package's `to`).
- **`schema-diff` ordering is correct and faithful** — creates-before-drops, stores-before-indexes, drop+create for in-place-unalterable index mutations, and an explicit throw on unsupported store-level (`keyPath`/`autoIncrement`) mutations rather than a silent no-op.
- **Driver transaction liveness, the `versionchange` multi-tab handler, FK wiring, cycle detection, destructive-default-refuse policy, and CLI `IDB-…-UNSUPPORTED` refusal envelopes** all remain as previously audited.
- **FEEDBACK.md §1–8 + the operational `versionchange` note remain fully addressed** (no regressions from the v0.12.0 migration).

### 🧹 Remaining cleanups — all closed this pass (follow-up commit)

After the fatal-flaw fix, the rest of the open ledger (everything except Phase 8 outbox) was cleaned up:

- **[Issue #21] — dead nested-write AST nodes — DELETED.** `IdbNestedCreateAst` / `IdbNestedUpdateAst` were unreachable (nested writes run in a `withMutationScope` transaction that bypasses the middleware chain by design — Issue #6, matching the vendor). Removed from the `IdbQueryAst` union and `idb-query-ast.ts`, with a comment recording _why_ there is intentionally no nested-write AST.
- **[Issue #24a] — non-atomic `upsert` — FIXED.** `upsert()` now runs find-then-write inside a single `withMutationScope` readwrite transaction when the executor supports transactions (always true for `IdbRuntime` → `createIdbClient` / `createAutoMigratingIdbClient`), removing the check-then-act window and matching the vendor's single-statement upsert. A bare bring-your-own `IdbQueryExecutor` (no `transaction()`) keeps the previous two-step fallback so the `./orm` "any executor" contract is preserved. Regression: "upsert — atomic path" test.
  > **Superseded (`feat/idb-referential-actions-followups`)** — the non-atomic fallback couldn't run `onUpdate` referential-action enforcement, so a cascade-triggering `upsert()` on a bare executor silently skipped it. Deleted rather than patched (no external consumers yet): `upsert()` now requires a transaction-capable executor unconditionally, matching `update`/`updateAll`/`deleteAll` (`create`/`delete` remain conditional — only when the write touches relations/FKs) — the `./orm` "any executor" contract no longer covers `upsert()`. The now-unreachable `IdbUpsertAst` plan-level node was deleted too, same rationale as [Issue #21]'s nested-write AST removal. See ADR 009's Consequences section.
- **[Issue #24b] — child-owned `connect` matches-one — FIXED.** Dropped the `take: 1` from the 1:N child-owned `connect` scan-write so it sets the FK on **every** row matching the criterion, matching the vendor's `executeUpdateCount` (identical to before for the normal unique criterion). Regression: "1:N connect matches all" test.
- **`openAndUpgrade` `onblocked` handler — ADDED.** A stray third-party connection holding the DB at an older version would otherwise hang the upgrade forever; it now rejects with an actionable message. (Unreachable in normal operation — runtime connections self-close on `versionchange` — but free insurance.)
- **`control-instance.ts` dead `void APP_SPACE_ID` import — REMOVED.**

The only genuinely-still-open item is the `introspect` / `readMarker` / `readAllMarkers` "lying refusals" — these return `null` / `{ stores: {} }` because the framework SPI types them as concrete `ContractMarkerRecord | null` / `IdbSchemaIR`, not result envelopes. The values returned are correct ("nothing on a live DB the CLI can't reach"), and the refusal is surfaced via the sibling `verify` / `sign`. Resolving it properly needs an upstream `unsupported` discriminator on those SPI return types — tracked as a framework-level question, not an IDB-side bug.

- Phase 8 (outbox sync) — intentionally unstarted.

---

## Audit 2026-05-29

Third-pass review, triggered by an external request to vet the IDB packages against the cloned vendor reference (`vendor/prisma-next/`) and `FEEDBACK.md`. Scope: the **still-uncommitted Phase 6.4 nested-write work** plus a fresh fatal-flaw sweep. Method: read every Phase 6.4 file against the vendor `sql-orm-client/mutation-executor.ts`, ran every package's `vitest` **and** `tsc --noEmit` separately, traced IDB transaction-liveness across `await` boundaries, and re-walked the migration apply path.

### Test + typecheck status (run 2026-05-29)

| Package       | `vitest` | `tsc --noEmit`                                                             |
| ------------- | -------: | -------------------------------------------------------------------------- |
| `target-idb`  |       80 | ✅ clean                                                                   |
| `driver-idb`  |       57 | ✅ clean                                                                   |
| `adapter-idb` |       29 | ✅ clean                                                                   |
| `runtime-idb` |       21 | ✅ clean                                                                   |
| `family-idb`  |       79 | ✅ clean                                                                   |
| `client-idb`  |       80 | ✅ clean (was ❌ 3 production + 54 test errors before the [Issue #20] fix) |

**The runtime was always correct — every behaviour test passed, including 3 real-browser nested-write Playwright spec files.** The problem was purely at the type layer: `vitest` runs through `esbuild`, which strips types, so the type errors were invisible to `pnpm test`. `pnpm check` / `pnpm build` (which run `tsc`) was red until the fix below.

### ✅ Issue #20 — `client-idb` failed `tsc --noEmit` after Phase 6.4 (build gate was red) — FIXED 2026-05-29

**Symptom.** `pnpm --filter @prisma-idb/client-idb check` failed with 3 production + 54 test errors.

**Root cause (the interesting one).** `create()`'s parameter type was widened from `CreateInput` to `MutationCreateInput` (= `CreateInput & RelationMutationFields`). But `RelationMutationFields` mapped over `ReferenceRelKeys`, and **when `ReferenceRelKeys` widens to `string`** (any loosely-typed `IdbContract` with no emitted type maps — i.e. every unit-test contract) the mapped type collapsed to an index signature `{ [k: string]: callback }`, which forced _every_ field — scalars included — to be a relation callback. So `create({ name: "Alice" })` failed with "`string` is not assignable to `(mutator) => …`". This was a latent production type-soundness bug, not just a test issue: it would have broken any consumer using a non-emitted contract.

**Fix.**

1. [types.ts](client-idb/src/core/types.ts) `RelationMutationFields` — added a `string extends ReferenceRelKeys<…> ? unknown : Partial<{…}>` guard. When the relation-key union widens to `string`, the type contributes no constraint (`& unknown` is identity), so plain scalar payloads type-check; precisely-typed (emitted) contracts still get full callback typing. **This one change cleared all 3 production errors' root and every `orm.test.ts` / `auto-migrate-evolution.test.ts` error.**
2. [store-accessor.ts:472](client-idb/src/core/store-accessor.ts#L472) `upsert()` — narrowed cast `this.create(args.create as MutationCreateInput<TContract, ModelName>)` (a `CreateInput` with no callbacks is always a valid `MutationCreateInput`; the generic intersection can't be proven in the class body).
3. [mutation-executor.ts](client-idb/src/core/mutation-executor.ts) — dropped the unused `contract` param from `readParentColumnValues` and the unused `relation` param from `buildParentJoinFilter` (both SQL-port leftovers; IDB needs no column mapping).
4. `test/mutation-executor.test.ts` — typed the `(rel)` callback params via a `RelMutator = IdbRelationMutator<typeof contract, string>` alias, deleted a stray `await import(...).IdbFilterExpr` (importing a **type** as a value), and switched `orm_().users`/`orm_().posts` to indexed `["users"]!`/`["posts"]!` access.

**Verification.** `tsc --noEmit` exit 0; `vitest` 80/80; `prettier --check` + `eslint` clean on all source. (The only residual `pnpm lint` warnings are `dist/*` build artifacts, which are gitignored — a pre-existing `.prettierignore` gap unrelated to this work.)

**Verified real, not a stale-`dist` artifact.** Reverting the fixes, running a full fresh `pnpm build` (every package's dist regenerated), then `tsc --noEmit` reproduced all 3 production errors — and the IDE's live language server flagged the `upsert` error independently. The `TS6133` unused-param errors are also logically immune to dependency-dist staleness.

**Process takeaway.** CI already runs `pnpm check` (`.github/workflows/build.yml`), and `turbo.json`'s `check` task `dependsOn: ["^build"]`, so **this would have failed the CI typecheck job on push** — the type gate exists. The trap is purely _local_: `pnpm test` runs through `vitest`/`esbuild` (strips types) and `pnpm build` runs through `tsdown` (isolated-declarations, emits `.d.ts` without failing on type errors), so **neither local command catches this** — only `pnpm check`/`tsc` does. To avoid pushing a red-CI commit, run `pnpm check` locally before committing Phase work (or add `tsc --noEmit` to the husky/lint-staged pre-commit). This was the third recurrence of the [Issue #19] pattern.

### ✅ Issue #21 — nested-write AST nodes are dead code — FIXED (deleted) 2026-06-04

`adapter-idb/src/core/idb-query-ast.ts` had `IdbNestedCreateAst` and `IdbNestedUpdateAst` in the `IdbQueryAst` union, but `store-accessor.ts` never emitted them: when `hasNestedMutationCallbacks` is true, `create()`/`update()` call `executeNestedCreateMutation` / `executeNestedUpdateMutation` directly, which run inside a `withMutationScope` transaction that bypasses the `RuntimeCore` middleware chain by design (Issue #6 — matches the vendor, where transactions also bypass per-op middleware). The two types were therefore unreachable. **Resolution: deleted** (the cleaner of the two options the feedback offered — wiring would have required a fake observation path that doesn't match the vendor). A comment in `idb-query-ast.ts` now records why there is intentionally no nested-write AST node.

### ✅ Issue #22 — recursive nested writes throw a cryptic `DataCloneError` — FIXED 2026-06-04

The vendor's `applyParentOwnedMutation` / `applyChildOwnedMutation` call `createGraph` **recursively**, so nested-within-nested writes work to arbitrary depth. Our IDB port deliberately calls `insertSingleRow` instead and documents "recursive nesting is not supported in Phase 6.4." That is a fine scope cut — but the failure mode was bad: a user who nested a relation callback inside a nested create passed a **function** as a field value, which `insertSingleRow` handed to `store.put(...)`; IDB's structured-clone threw an opaque `DataCloneError` instead of a clear message.

**Fix.** `insertSingleRow` now calls `assertNoNestedCallbacks(modelName, data)` ([mutation-executor.ts](client-idb/src/core/mutation-executor.ts)), which scans the record for any function-valued field and throws a descriptive _"Recursive nested writes are not supported: field `X` … is a relation callback"_ error before the `put`. Regression test in `client-idb/test/mutation-executor.test.ts` ("rejects recursive nesting with a descriptive error").

### ✅ Issue #23 — no apply-time integrity check against `migrationHash` — FIXED 2026-05-31

`walkChain` in `auto-migrate.ts` now calls `computeMigrationHash(next.metadata, next.ops)` for each package and throws if it doesn't match `next.metadata.migrationHash`. The `_contract-space-fixture.ts` test helper was updated to compute real hashes instead of the `sha256:fixture-N` stubs it previously used (its comment admitted the stub was there because auto-migrate didn't validate — now it does).

> **Superseded 2026-06-02 (browser-crypto fix).** The original 2026-05-31 fix imported `computeMigrationHash` from `@prisma-next/migration-tools/hash`, which uses `node:crypto`'s `createHash` and **threw in the browser** — see [§ Phase 6.5–6.7](#phase-65-67-include-refinement-aggregate-select-2026-06-02). It is now a byte-identical WebCrypto re-implementation in `client-idb/src/core/migration-hash.ts` (reuses the framework's `canonicalizeJson` + the same nested SHA-256/hex scheme), and `walkChain` is `async`. The integrity check is unchanged in meaning; only the digest primitive moved from Node crypto to WebCrypto so it runs in the browser. `auto-migrate-evolution.test.ts` (real fixture hashes) confirms the byte-for-byte match.

### ✅ Issue #24 — `upsert` is non-atomic; child-owned `connect` diverges from vendor — FIXED 2026-06-04

Both faithfulness gaps closed:

- **`upsert()` atomicity.** Now runs find-then-write inside a single `withMutationScope` readwrite transaction whenever the executor supports transactions (always true for `IdbRuntime` via `createIdbClient` / `createAutoMigratingIdbClient`), eliminating the check-then-act window and matching the vendor's single-statement upsert. A bare bring-your-own `IdbQueryExecutor` (no `transaction()`) retains the previous two-step path so the `./orm` "any executor" contract still holds. Regression: `mutation-executor.test.ts` "upsert — atomic path".
- **Child-owned `connect`.** Dropped the `scan-write { take: 1 }` cap, so a 1:N `connect` sets the FK on **every** row matching the criterion — matching the vendor's `executeUpdateCount` (identical to the old behavior for the normal unique-key criterion). Regression: `mutation-executor.test.ts` "1:N connect matches all".

> **Superseded (`feat/idb-referential-actions-followups`)** — the non-atomic fallback described above is gone. It couldn't run `onUpdate` referential-action enforcement (added later on that branch), so a cascade-triggering `upsert()` on a bare executor would have silently skipped it. Rather than special-case around that, the fallback was deleted: `upsert()` now calls `requireTransactionExecutor()` unconditionally and always takes the atomic path, matching `update`/`updateAll`/`deleteAll` (which already required a transaction-capable executor unconditionally; `create`/`delete` remain conditional, requiring one only when the write touches nested relations, scalar FK fields, or enforceable child relations). The `./orm` "any executor" contract no longer extends to `upsert()`. The plan-level `IdbUpsertAst` AST node (only ever produced by the deleted fallback) was removed too, for the same reason `IdbNestedCreateAst`/`IdbNestedUpdateAst` were in [Issue #21]. Justified by project stage, not by any bug report: no external consumers exist yet, so there was no reason to keep a permissive contract for a case that was already untested and unreachable through the shipped client factories. Regression: `fk-enforcement.test.ts` "upsert — requires a transaction-capable executor".

### ✅ Issue #25 — two-phase marker write has no crash-recovery guard — FIXED 2026-06-04

Per ADR 002, the marker is written in a separate `readwrite` transaction _after_ the version-change upgrade commits (`openAndUpgrade` → `onsuccess` → `writeMarker`). If the tab is killed in the window between the upgrade committing and the marker write landing, the schema is advanced but the marker still points at the old `storageHash`. On the next open, `walkChain` re-collects the already-applied ops and `applyOneDdlOp` calls `db.createObjectStore(...)` on a store that already exists → the version-change transaction aborts → **the DB is wedged permanently** (every subsequent open repeats the failed upgrade).

This was upgraded from 🟢 to a genuine fatal flaw on closer inspection: **ADR 002 actively documented a _false_ safety guarantee** — it claimed DDL ops are "idempotent under 'store already exists' semantics (IDB's own guarantee)". IndexedDB offers no such guarantee; `createObjectStore`/`createIndex` throw `ConstraintError` on an existing target.

**Fix.** `applyOneDdlOp` ([apply-ddl-op.ts](target-idb/src/core/apply-ddl-op.ts)) is now explicitly idempotent — every op is guarded by an existence check (`db.objectStoreNames.contains(...)` for stores, `store.indexNames.contains(...)` for indexes; drops guard the inverse). Replaying an already-applied op is now a no-op, so the post-crash recovery run that ADR 002 describes actually works. ADR 002's false claim and failure-mode table were corrected. Two regression tests added in `target-idb/test/migration.test.ts` ("crash-recovery replay" + idempotent drops) replay the full op set at a bumped version against `fake-indexeddb` and assert no throw. The alternative (writing the marker inside the `versionchange` transaction) remains a possible future simplification but is a larger ADR-002 change; the idempotency guard is the minimal, ADR-aligned fix.

### ✅ Confirmed-good (re-verified this pass)

- **`versionchange` multi-tab handler is present and on the right connection** — `idb-driver.ts` installs `db.onversionchange = () => db.close()` in `openIdbDatabase.onsuccess`. The `FEEDBACK.md` "one operational issue" is genuinely resolved on the runtime connection.
- **Transaction liveness across `await` is sound.** `scope.execute()` resolves from inside the IDB request's `onsuccess` (`execPut`/`execCursorScan`/… call `onComplete` in the request callback), so each awaited op resumes within a microtask while the transaction is still active and issues the next request before auto-commit — the canonical IDB keep-alive pattern. The 3 nested-write Playwright specs exercise this against **real Chromium IndexedDB**, not just `fake-indexeddb`, which is the correct guard against the browser-divergence class `FEEDBACK.md` warns about.
- **FK wiring is correct** for both 1:N (child FK ← parent PK) and N:1 (parent FK ← related PK), confirmed against the vendor and by the 14 mutation-executor tests.
- **Manifest is gone, destructive policy defaults to refuse, `walkChain` has cycle detection, storageHash chain is internally consistent** — all as designed post-Phase-7.

### Recommended next steps (this audit)

1. ✅ **Make `client-idb` green under `tsc`** ([Issue #20]) — done 2026-05-29 (type guard + casts + test fixes). Phase 6.4 is now safe to commit.
2. CI already gates this (`pnpm check` in `build.yml`, with `^build` first), so a red `tsc` fails CI on push. The remaining gap is _local_: `pnpm test` and `pnpm build` don't typecheck. Optional hardening — add `tsc --noEmit` to the husky `lint-staged` pre-commit so the recurring [Issue #19]/[Issue #20] class is caught before push, not just in CI.
3. Add the recursive-nesting guard ([Issue #22]) and the `migrationHash` apply-time assertion ([Issue #23]).
4. Resolve or delete the dead nested-write AST nodes ([Issue #21]).
5. Then proceed to Phase 6.5–6.7 as previously scoped.

---

## Phase 6.5-6.7: Include refinement, aggregate, select (2026-06-02)

Shipped the final three Phase-6 ORM features, ported as closely as possible from the vendor `sql-orm-client` reference (collapsed to IDB's all-in-memory model — no SQL compilation, no codec traits, no column mapping). This completes the Phase 6 ORM lane (6.1–6.7).

### What shipped

**Phase 6.5 — Include refinement.** `include(rel, refineFn?)` now takes an optional refinement callback (mirrors `sql-orm-client/collection.ts` `include()` + `include-descriptors.ts`).

- `IdbAccessorState.includes` changed from `Record<string, true>` to `Record<string, IncludeEntry>` where `IncludeEntry` is `{ kind: "collection"; state }` or `{ kind: "scalar"; fn: "count"; state }` (`store-state.ts`).
- The refinement callback receives a fresh child accessor in **include-refinement mode**; its chained `where`/`orderBy`/`take`/`skip` build the child `IdbAccessorState`. `include()` reads that state back (cross-instance private field access) to build the `IncludeEntry`.
- Scalar `count()`: in refinement mode, `count()` returns an `IdbIncludeScalar` marker instead of the async terminal (the `IdbIncludeRefinementAccessor` type surfaces this; one documented cast bridges the dual role). The relation field becomes a `number`. Rejected at build time on to-one relations (matches vendor).
- `relation-loader.ts` rewritten to take the `IncludeEntry`: refined `where` filters the child scan; `orderBy`/`skip`/`take` apply **per parent group** for `1:N`; scalar attaches per-parent child counts.

**Phase 6.6 — Aggregate / groupBy.** Pure in-memory reduction (IDB has no aggregation API).

- `aggregate-builder.ts` — `createAggregateBuilder()` (`count`/`sum`/`avg`/`min`/`max` selectors), `isAggregateSelector`, `reduceAggregate` (null over empty set, per Prisma + vendor `coerceAggregateValue`), `computeAggregateSpec`, `assertValidAggregateSpec`.
- `grouped-accessor.ts` — `IdbGroupedAccessor` (port of `GroupedCollection`); `accessor.groupBy(...).aggregate(fn)` partitions materialised rows by a composite key and reduces each group. Standalone `accessor.aggregate(fn)` reduces the whole filtered set.
- `IdbAggregateAst` / `IdbGroupByAst` added to `adapter-idb`'s `IdbQueryAst` union and **attached to the materialising cursor-scan plan** — so they're reachable for middleware (deliberately not dead code, cf. [Issue #21]).

**Phase 6.7 — Select projection.** `select(...fields)` narrows the row shape (mirrors `selection-shaping.ts`).

- Added a 4th type param `TSelected extends string = never` to `IdbStoreAccessor` / `IdbStoreAccessorImpl`, threaded through the chainable methods; `SelectedRow<…>` narrows the row to `Pick<DefaultModelRow, TSelected> & IncludeFields<…>`.
- `selectedFields` stored in state; projection runs **after** relation loads in `all()`, so FK fields needed by `include()` survive the scan→load→project pipeline even when not selected (the IDB-simple equivalent of `augmentSelectionForJoinColumns`).
- Shared helpers extracted to `query-shaping.ts` (`combineFilterExprs`, `buildRowComparator`) — used by both the store accessor and the relation loader (removed the duplicate private comparator/filter-combine logic).

### ✅ Bonus fix — browser-only `createHash` crash in the auto-migrate integrity check

While wiring the demo Playwright specs, **every** spec (including the pre-existing smoke suite) failed at fixture setup: the demo client never finished initialising. Root cause was a **pre-existing** regression, not the 6.5–6.7 work: the [Issue #23] integrity check (`auto-migrate.ts` `walkChain`) imported `computeMigrationHash` from `@prisma-next/migration-tools/hash`, which calls `node:crypto`'s `createHash`. In the browser that bundles to `(0, ia.createHash) is not a function`, thrown on every `createAutoMigratingIdbClient` call → the whole demo app was dead in any browser, and the failure was invisible to the node-only vitest suite (the exact "node API breaks the browser" class `FEEDBACK.md` warns about).

**Fix.** New `client-idb/src/core/migration-hash.ts` re-implements the hash with **WebCrypto** (`crypto.subtle.digest("SHA-256", …)` → hex), reusing the framework's own `canonicalizeJson` and the identical nested-hash scheme, so it is **byte-identical** to the CLI-recorded `migrationHash` (the integrity check stays meaningful). `walkChain` is now `async` and awaits it. Confirmed identical by `auto-migrate-evolution.test.ts` (real fixture hashes) staying green, and by the demo app initialising and all 93 Playwright specs passing.

### Tests

| Suite                                | Count                | Notes                                                                                             |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| `client-idb` vitest                  | 99 (was 80; **+19**) | 8 include-refinement, 7 aggregate/groupBy, 4 select — full stack via `fake-indexeddb`             |
| `adapter-idb` vitest                 | 29                   | unchanged (AST additions are type-only)                                                           |
| demo Playwright (`prisma-idb-usage`) | 93 (was 77; **+16**) | `includeRefinement/{whereInsideInclude,scalarInclude}`, `modelQueries/{aggregate,groupBy,select}` |

All `tsc --noEmit`, eslint, prettier, and isolated-declaration `tsdown` builds clean across `client-idb` + `adapter-idb`.

### Files

- `client-idb/src/core/`: **new** `aggregate-builder.ts`, `grouped-accessor.ts`, `query-shaping.ts`, `migration-hash.ts`; **edited** `store-accessor.ts`, `store-state.ts`, `types.ts`, `relation-loader.ts`, `auto-migrate.ts`, `exports/orm.ts`.
- `adapter-idb/src/core/idb-query-ast.ts` + `exports/runtime.ts`: `IdbAggregateAst`, `IdbGroupByAst`, `IdbAggregateRequest`.

---

## v0.12.0 migration (2026-06-04)

Full migration of all 7 idb packages to `@prisma-next/*@0.12.0`. Every breaking change required a matching fix; the migration was applied in build-dependency order (target-idb → family-idb → runtime-idb → client-idb → adapter/driver check → demo app).

### Breaking changes and fixes

**1. Domain plane restructure — `Contract.models` removed**

`Contract.models` no longer exists. Models now live under `contract.domain.namespaces.<ns>.models`. The framework ships a `contractModels(contract)` runtime helper that flattens all namespace models into a single map (de-namespacing), and a `ContractModelsMap<TContract>` type-level analogue.

- `client-idb/src/core/types.ts` — added a local `ModelsOf<TContract>` helper (uses `ContractModelsMap`) so all model-level type helpers (`ModelKeyPath`, `ModelRelations`, `RelationRowType`, `RelatedModelOf`) work against the new shape without requiring a `TContract extends Contract` constraint. Updated `getStoreName()`, `getKeyPath()`, `getRelation()` to call `contractModels(contract)`.
- `client-idb/src/core/relation-loader.ts` — uses `contractModels(contract)` for all model lookups.
- `client-idb/src/core/mutation-executor.ts` — same.
- `family-idb/src/core/validate.ts` — replaced `contract.models` with `contractModels(contract)`.
- `family-idb/src/core/contract-builder.ts` — `defineContract()` now builds the `domain = { namespaces: { [ns]: { models } } }` structure. Removed top-level `models` from the emitted contract object.

**2. `CrossReference` — `relation.to` changed from `string` to `{ namespace, model }`**

- `client-idb/src/core/idb-orm.ts` — `IdbOrmClient` type now maps over `TContract["roots"]` entries (CrossReference objects). Runtime: `for (const [rootKey, ref] of Object.entries(contract.roots)) { … ref.model … }`.
- `client-idb/src/core/store-accessor.ts` — `rel?.to.model` (was `rel?.to`).
- `client-idb/src/core/relation-loader.ts` — `relatedModelName = relation.to.model`.
- `client-idb/src/core/mutation-executor.ts` — same.
- `family-idb/src/core/contract-builder.ts` — `buildRoots()` returns `Record<string, CrossReference>` using `crossRef(modelName)`; relation `to` field uses `crossRef(rel.to)`.
- `types.ts` — `RelationRowType` matches `to: { model: infer To extends string }`.

**3. `StorageBase` now requires `namespaces`**

`StorageBase` gained a `namespaces: Record<string, StorageNamespace>` field (symmetric with `domain.namespaces`).

- `family-idb/src/core/contract-builder.ts` — `storage = { stores, namespaces: { [ns]: { id: ns } }, storageHash }`.
- Test fixtures (`family-idb/test/`) — updated inline raw contract objects to include `storage.namespaces`.

**4. `MigrationRunner` SPI merge — `MultiSpaceCapableRunner` dissolved**

`MultiSpaceCapableRunner` + the old `execute({plan, driver, ...})` shape were merged into a single `MigrationRunner.execute({driver, perSpaceOptions})`.

- `target-idb/src/core/migration-runner.ts` — `IdbMigrationRunner` now implements only `MigrationRunner<"idb","idb">` (no `MultiSpaceCapableRunner`). The single `execute` returns the `IDB-RUNNER-CLI-UNSUPPORTED` refusal with `failingSpace` inlined on the failure object (no `MultiSpaceRunnerFailure` wrapper).
- `target-idb/test/migration.test.ts` — consolidated two runner tests into one using `execute({ driver, perSpaceOptions: [] })`.

**5. `RuntimeMiddlewareContext.planExecutionId` added**

New required `string` field for per-execute correlation.

- `runtime-idb/src/idb-runtime.ts` — `buildMiddlewareContext()` now includes `planExecutionId: crypto.randomUUID()`.
- `runtime-idb/test/runtime.test.ts` — both `customCtx` mock literals updated to include `planExecutionId: "test-plan-exec"`.

**6. `migrationHash` algorithm change — strips only `migrationHash` (not `hints`)**

`hints` and `labels` were removed from the manifest schema in 0.12.0, so the hash now strips only `migrationHash` from metadata before hashing.

- `client-idb/src/core/migration-hash.ts` — removed `delete stripped["hints"]`.

**7. `@prisma-next/contract/testing` subpath removed**

`createContract` from the testing subpath was deleted upstream.

- `family-idb/test/_raw-contract.ts` (new) — `createRawIdbContract(stores, models?)` replacement that builds a valid 0.12.0-shape contract with `domain.namespaces.__unbound__` and computes real hashes.
- `family-idb/test/control.test.ts`, `schema-verify.test.ts` — switched to `createRawIdbContract`.
- `family-idb/test/emission.test.ts` — updated `makeRawWithStorage` and two inline raw contracts to include `domain.namespaces.__unbound__`.

**8. Demo app contract regeneration**

- `apps/prisma-orm-usage/package.json` — `prisma-next` bumped to `^0.12.0`.
- Ran `pnpm prisma contract emit` → new `contract.json` + `contract.d.ts` (storageHash `sha256:b05717321fba711de059ca6e508f0f2087f2eaca7de74beb8f969ac5f0c606d9`).
- Deleted old migration dirs (`20260527T1635_baseline`, `20260527T1637_migration`); ran `prisma-idb generate-baseline` → fresh `20260603T0515_baseline` (7 ops, `from: null`).
- Ran `prisma-idb migration contract-space` → regenerated `contract-space.generated.ts`.

### Tests (2026-06-04)

| Package / Suite               |   Tests | Status |
| ----------------------------- | ------: | ------ |
| `adapter-idb`                 |      29 | ✅     |
| `driver-idb`                  |      57 | ✅     |
| `runtime-idb`                 |      21 | ✅     |
| `target-idb`                  |      79 | ✅     |
| `family-idb`                  |      79 | ✅     |
| `client-idb`                  |      99 | ✅     |
| `cli-tests`                   |      20 | ✅     |
| Playwright (prisma-idb-usage) |      93 | ✅     |
| **Total**                     | **477** | ✅     |

---

## Audit 2026-05-28

Second-pass review on top of Phase 7. Cross-checked our six packages against the cloned vendor reference (`vendor/prisma-next/`), re-read every section of [`FEEDBACK.md`](FEEDBACK.md), ran every test (vitest + playwright), and exercised the CLI surfaces end-to-end. What follows is the **only** unaddressed material — Phase 7's eight sub-phases handled everything in FEEDBACK §1–8 cleanly, but a handful of cleanup edges escaped that pass.

### ✅ FEEDBACK.md coverage check

| FEEDBACK §  | Topic                                    | Status                                                                                                                                                           |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1           | Missing migration package layer          | ✅ Done — 4-file packages on disk, `migration.ts` self-emit shim, `MigrationCLI.run(...)`, `IdbMigration` base, ops/end-contract per package                     |
| 2           | Planning at design time, not browser     | ✅ Done — `IdbMigrationPlanner` runs only in CLI / preflight; browser never imports it; `auto-migrate.ts` walks the bundled `contractSpace.migrations`           |
| 3           | Delete the manifest                      | ✅ Done — `family-idb/manifest*` files deleted; control-instance returns `IDB-CLI-UNSUPPORTED` envelopes; in-DB marker is the only authoritative position record |
| 4           | Safe default destructive policy          | ✅ Done — `SAFE_POLICY = { allowedOperationClasses: ["additive","widening"], onDestructive: "refuse" }` in `auto-migrate.ts`                                     |
| 5           | Space-keyed marker (`"app"` from day 1)  | ✅ Done — `createMarkerStoreOp` uses `keyPath: "space"`, writes full `ContractMarkerRecord` shape (8 fields, was 3)                                              |
| 6           | `executeAcrossSpaces` duck-typing        | ✅ Done — manifest IO removed entirely; `family-idb` no longer reads/writes any on-disk shadow                                                                   |
| 7           | `fake-indexeddb` as standalone preflight | ✅ Done — `prisma-idb migration preflight` command; only legitimate runtime/CLI use of `fake-indexeddb`                                                          |
| 8 (op note) | `versionchange` handler                  | ✅ Done — `openIdbDatabase` in `driver-idb` installs `db.onversionchange = () => db.close()`                                                                     |

All Phase 7 sub-phases (7.1–7.8) shipped tests; the test suite went from 306 vitest before Phase 7 to **353 vitest + 65 Playwright = 418 total** after this audit's fixes.

### ✅ Issue #17 — demo app config references deleted `IdbManifestControlDriverDescriptor` — FIXED

**Symptom.** [apps/prisma-orm-usage/prisma.config.ts](apps/prisma-orm-usage/prisma.config.ts) (post-Phase 7.7) imported `IdbManifestControlDriverDescriptor` from `@prisma-idb/family-idb/control` and passed it as `driver:`. Phase 7.3 deleted that descriptor (along with the manifest-driver source files). The named import silently resolved to `undefined` — `prisma-next db verify` / `db init` / `db update` all returned `PN-CLI-4010 "Driver is required"` rather than the intended `IDB-CLI-UNSUPPORTED` refusal envelope.

**Hidden because.** The TS config isn't included in `apps/prisma-orm-usage/tsconfig.json`'s `include` list (it lives outside `src/`), so the broken import never produced a type error. The Playwright suite drives the in-browser path and doesn't touch the CLI. Only a manual `pnpm prisma-next db verify` invocation surfaces the failure.

**Fix.** Switched `driver:` to import `default` from `@prisma-idb/driver-idb/control` (the stub `idbControlDriverDescriptor` whose `query()` / `close()` are no-ops). Set `db.connection: ":memory:"` since IDB ignores it. Also deleted the now-stale `apps/prisma-orm-usage/prisma-idb.manifest.json` — left over from pre-Phase-7 and confusing as dead data in the repo.

**Verification.** `pnpm prisma-next db verify` now returns the structured `IDB-CLI-UNSUPPORTED` envelope as designed.

### ✅ Issue #18 — `defineContract` emits empty capabilities, diverging from `prisma contract emit` — FIXED

**Symptom.** [family-idb/src/core/contract-builder.ts](family-idb/src/core/contract-builder.ts) `defineContract()` set `capabilities: {}` and passed `{}` to `computeProfileHash`. The CLI path (`prisma contract emit`) produces `capabilities: { idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } }`. The two authoring paths therefore produced contracts with different `profileHash` values for byte-identical schema input.

**Impact.** Latent today because (a) no runtime path reads `contract.capabilities`, and (b) the demo app uses `prisma contract emit` end-to-end. A user authoring entirely via TS (`defineContract → typescriptContract`) and a user authoring via the CLI emitter would have produced markers with divergent profileHashes against the same logical schema — a confusing data drift bug.

**Fix.** `defineContract` now bakes in the same `{ idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } }` capabilities literal both into the contract object and into `computeProfileHash`'s input. The two authoring paths are now byte-equivalent.

### ✅ Issue #19 — `runtime-idb` mock driver missing `transaction` method (`tsc --noEmit` fails) — FIXED

**Symptom.** [runtime-idb/test/runtime.test.ts:79](runtime-idb/test/runtime.test.ts#L79) `makeMockDriver()` returned an object without a `transaction` method. Phase 6.3 added `transaction(storeNames, mode?): Promise<IdbTransactionScope>` to `IdbRuntimeDriverInstance`; the test fixture wasn't updated.

**Hidden because.** `vitest` runs through `esbuild`, which strips types but doesn't enforce them. `pnpm test` was green. A direct `pnpm exec tsc --noEmit` in the package surfaced two TS2741/TS1360 errors on the `satisfies` clause.

**Fix.** Added a `transaction: defaultTransaction` field that throws "mock driver does not implement transaction()" — keeps existing tests behavior-unchanged but satisfies the interface. Tests still 21/21 green, and `tsc --noEmit` now passes cleanly.

### Open: subtle / non-fatal issues left for follow-up

These don't break anything today, but each is worth flagging for the next maintenance pass:

1. ~~**`IdbMigrationRunner.execute()` is dead in production**~~ ✅ **Fixed (2026-05-28)**: `execute()` now returns the same `IDB-RUNNER-CLI-UNSUPPORTED` refusal envelope as `executeAcrossSpaces()`. DDL tests were moved to an `openAndUpgrade` describe block that calls it directly.

2. ~~**`walkChain` in `client-idb/auto-migrate.ts` has no cycle detection**~~ ✅ **Fixed (2026-05-28)**: Added a `visited: Set<string | null>` guard; throws loudly if a hash is revisited before reaching the head.

3. ~~**`runtime-idb` `buildMiddlewareContext` hard-codes `scope: "runtime"`**~~ ✅ **Fixed (2026-05-28)**: `scope: "runtime"` is always correct — `IdbTransactionScope.execute()` bypasses middleware entirely, so middleware is only ever reached from the top-level `execute()` path (runtime scope). There is no IDB connection pool, so `"connection"` is not applicable. Added a comment to `buildMiddlewareContext` explaining this invariant.

4. ~~**`count()` respects `skip`/`take` from the chain**~~ ✅ **Fixed (2026-05-28)**: Documented the divergence from Prisma's SQL `count()` in the `IdbStoreAccessor.count()` interface JSDoc. Behavior is intentional and now surfaced to users.

5. **`introspect`, `readMarker`, `readAllMarkers` "lying refusals"** in `family-idb/control-instance.ts` return `null` / empty schema rather than the `IDB-CLI-UNSUPPORTED` envelope the sibling methods use. The framework's `MigratableTargetFamilyInstance` typing forces these to return concrete values, not Result envelopes. Today's `null` / `{ stores: {} }` is technically correct ("nothing on disk"), but it can mislead framework code paths that branch on it. If the framework SPI grows a `unsupported` discriminator, switch over.

### Recommended next steps (post-audit)

1. **Phase 6.4** — Nested relation writes; the foundation (`withMutationScope` + `IdbBatchPlan`) is ready. Port `parseMutationInput`, `partitionByOwnership`, `createGraph`, `updateFirstGraph`, `IdbRelationMutator` from `sql-orm-client`.
2. **Decide on the `readMarker` legacy fallback** (Issue #6 in this section). One-line code change vs. one-line documentation update — pick one.
3. **Fold backfill + rename op execution** into the apply path. The Phase 7 design makes both _representable_ (any op in `ops.json` is applied verbatim), but the IDB runner doesn't yet have a code path to invoke developer-authored closures inside the apply transaction. Track as a separate phase once Phase 6.4 lands.
4. **Phases 6.5–6.7** as previously scoped.

---

## Phase 5 — Migration infrastructure (target-idb/control) ✅ Done

**Goal:** Make `target-idb` a `MigratableTargetDescriptor`. The target gains a planner that diffs two `IdbSchemaIR`s into an ordered DDL op sequence, and a runner that executes that sequence inside IndexedDB's `upgradeneeded` callback.

**Completed additions beyond the original plan:**

- Planner includes creation of the `_prisma_next_marker` object store on first migration
- Runner writes the contract marker record (`storageHash`, `profileHash`, `updatedAt`) after DDL succeeds
- Driver exposes `MARKER_STORE_NAME` and `IdbMarkerRecord` so the runtime can read/verify the marker
- Runtime's `verifyMarker()` cross-checks the live marker against the contract before query execution

### Mental model

```
Planner:  fromContract → IdbSchemaIR
          contract     → IdbSchemaIR
          diff(from, to) → IdbDdlOp[]
          wrap → IdbMigrationPlanWithAuthoring

Runner:   factory.open(dbName, targetVersion)
          upgradeneeded → applyDdlOps(db, tx, ops)
          resolve → MigrationRunnerResult
```

The **planner** owns schema diffing. The **runner** owns DDL execution. The **manifest** (`idbVersion`) is owned by the caller (CLI or family instance) — the runner does not touch it. After a successful `runner.execute()`, the caller increments `idbVersion` in the manifest and calls `family.sign()`.

### Version tracking

- `IdbManifest` gains `idbVersion?: number` (integer, 1, 2, 3…)
- Caller computes `targetVersion = (manifest.idbVersion ?? 0) + 1` before building the migration driver
- IDB's native version-change mechanism is used (`factory.open(name, targetVersion)`)
- On success, caller writes `idbVersion: targetVersion` back to the manifest

> **Note (resolved 2026-05-25):** `IdbManifest` now carries the optional `idbVersion?: number` field, and `createAutoMigratingIdbClient` uses it when present (`baseVersion = manifest?.idbVersion ?? currentDbVersion`, `targetVersion = baseVersion + 1`). The runtime path is fully wired; the CLI path to _write_ the bumped `idbVersion` back to the manifest is gated on Issue #1 (`db update` doesn't run yet).

### New files in `target-idb/src/core/`

| File                     | What it does                                                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration-factories.ts` | `IdbDdlOp` discriminated union (`CreateObjectStoreOp`, `DropObjectStoreOp`, `CreateIndexOp`, `DropIndexOp`) + factory functions. Each op implements `MigrationPlanOperation` (`id`, `label`, `operationClass`).                                                             |
| `schema-diff.ts`         | `diffIdbSchema(from, to): IdbDdlOp[]` — ordered diff, creates before drops, stores before indexes.                                                                                                                                                                          |
| `migration-driver.ts`    | `IdbMigrationControlDriver` extends `ControlDriverInstance<"idb","idb">` with `{ dbName, factory: IDBFactory, targetVersion: number }`. `IdbMigrationControlDriverDescriptor.create({...})` + `extractMigrationDriver()`.                                                   |
| `migration-runner.ts`    | `IdbMigrationRunner implements MigrationRunner<"idb","idb">`. Extracts driver, filters ops by policy, opens DB at `targetVersion`, runs DDL in `upgradeneeded`.                                                                                                             |
| `migration-planner.ts`   | `IdbMigrationPlanner implements MigrationPlanner<"idb","idb">`. `plan()` converts contracts to schema IR, diffs them, returns `IdbMigrationPlanWithAuthoring`. `emptyMigration()` returns a stub plan. `contractToIdbSchema()` is exported for use in `descriptor-meta.ts`. |

### Updated files

| File                                     | Change                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target-idb/tsconfig.json`               | Add `"DOM"` to `lib` (needed for `IDBFactory`, `IDBDatabase`, `IDBTransaction` etc.)                                                                    |
| `target-idb/tsdown.config.ts`            | Add `src/exports/migration.ts` as a build entry                                                                                                         |
| `target-idb/package.json`                | Add `"./migration": "./dist/migration.mjs"` export                                                                                                      |
| `target-idb/src/core/descriptor-meta.ts` | No change — migrations capability goes on the control descriptor                                                                                        |
| `target-idb/src/exports/control.ts`      | Add `migrations` capability (`createPlanner`, `createRunner`, `contractToSchema`); change `satisfies` type to `MigratableTargetDescriptor<"idb","idb">` |
| `target-idb/src/exports/migration.ts`    | New — re-exports DDL op factories + types for user-authored migration files                                                                             |
| `family-idb/src/core/manifest.ts`        | Add `idbVersion?: number` to `IdbManifest`                                                                                                              |

### Key design constraints

- **DDL-only-in-upgrade**: IDB DDL can ONLY run inside `upgradeneeded`. The runner opens a version-change transaction by bumping the version number.
- **No manifest writes from runner**: The runner is a pure executor. Manifest updates are the caller's responsibility.
- **Policy filtering**: The runner filters ops by `policy.allowedOperationClasses` before executing. Additive ops pass a default policy; destructive require explicit allowance.
- **`exactOptionalPropertyTypes`**: All optional IDB API options (`autoIncrement`, `multiEntry`) use conditional spreads, never `undefined` assignment.

---

## Phase 6 — IDB ORM lane (`client-idb`) + runtime (`runtime-idb`) + demo app

**Status:** 🚧 Packages are implemented and tested. Demo app (`apps/prisma-orm-usage/`) exists with SvelteKit UI that exercises the happy path (`create`, `all`, `findUnique`, `delete`, `where {field: value}`, `orderBy`). Playwright is configured but no `*.e2e.ts` spec files exist yet — interactive testing only.

**New since original Phase 6 plan:**

- `client-idb` now ships three entrypoints: `./orm` (just the typed accessor factory), `./client` (full stack assembled), `./client-auto` (auto-migration on first use).
- `runtime-idb` builds a real `RuntimeMiddlewareContext` from the contract — including a `contentHash()` implementation that canonicalizes plan structure and SHA-512-hashes it via WebCrypto. Non-serializable fields (`IdbRowFilter`, `IdbRowComparator`, `IDBKeyRange`) are reduced to deterministic identity so identical queries hash identically. Suitable for `@prisma-next/middleware-cache`.
- `family-idb` exposes a `defineContract()` TypeScript-first authoring path (TS-first; no Prisma DSL needed), plus the `typescriptContract()` config helper consumed by `prisma.config.ts`.
- Grouping keys are attached to every plan via `plan.meta.annotations.groupingKey` (ADR 160). Sub-plans for `include()` reuse the same grouping key so middleware can correlate the main scan with its relation loads.

### `runtime-idb` (`@prisma-idb/runtime-idb`)

**Goal:** Wire the adapter and driver into a `RuntimeCore` subclass so the user gets a single `execute(plan)` call that handles lowering, execution, marker verification, and middleware.

**Key components:**

| File                | What it does                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idb-runtime.ts`    | `IdbRuntimeImpl extends RuntimeCore<IdbQueryPlan, IdbPlanBody, IdbMiddleware>`. Overrides `lower()` (threads contract through adapter), `runDriver()` (delegates to driver), `execute()` (identity pass-through), `close()` (closes IDB connection). Exposes `verifyMarker()` — reads `_prisma_next_marker` store and compares `storageHash` against contract. |
| `idb-middleware.ts` | `IdbMiddleware extends RuntimeMiddleware<IdbPlanBody>` with `family: "idb"` discriminant. Supports `beforeExecute`, `onRow`, `afterExecute` hooks.                                                                                                                                                                                                             |

**Constructor behavior:**

- When `ctx` is not provided, builds a `RuntimeMiddlewareContext` from the contract (with `mode: "permissive"`, log stubs, `now: Date.now`)
- When `ctx` is provided, uses it as-is — does not derive from contract

**`verifyMarker()` flow:**

1. Calls `driver.readMarker()` → `IdbMarkerRecord | null`
2. If null → returns `false` (database never initialised or pre-marker)
3. Compares `marker.storageHash` against `contract.storage.storageHash`
4. Match → `true`, mismatch → `false` (schema drift — run migrations)

### `client-idb` (`@prisma-idb/client-idb`)

**Goal:** `idbOrm({ contract, executor })` — a typed per-store client following the Mongo ORM pattern.

**Key components:**

| File                 | What it does                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idb-orm.ts`         | `idbOrm()` factory. Reads `contract.roots`, creates one `IdbStoreAccessorImpl` per root model. Returns `IdbOrmClient<TContract>` — a mapped type where each root key becomes an `IdbStoreAccessor`.                                           |
| `store-accessor.ts`  | `IdbStoreAccessorImpl` — typed per-model query builder. Methods: `create(data)`, `all()`, `where(filter)`, `first(filter?)`, `findUnique(key)`, `delete(key)`. Every method builds an `IdbQueryPlan` with a `groupingKey` and optional `ast`. |
| `executor.ts`        | Thin `IdbQueryExecutor` interface: `execute<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row>`. Structurally satisfied by `IdbRuntime`.                                                                                                 |
| `relation-loader.ts` | `include()` support — loads related records via foreign key lookups.                                                                                                                                                                          |
| `store-state.ts`     | Per-store `groupingKey` counter — generates `"idb-op-N"` keys threaded into every plan's meta.                                                                                                                                                |
| `types.ts`           | `IdbContract`, `WhereFilter`, `CreateInput`, `KeyType`, `DefaultModelRow` etc.                                                                                                                                                                |

**Plan enrichment (added to adapter-idb):**

| File               | What it does                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idb-query-ast.ts` | `IdbQueryAst` union type — `findMany`, `findUnique`, `create`, `delete` AST nodes. Attached as `plan.ast` by the store accessor so middleware can inspect query intent. |

### Mongo ORM pattern (the model to follow)

```ts
// @prisma-next/mongo-orm pattern:
const client = mongoOrm({ contract, executor });
// executor = { execute<Row>(plan): AsyncIterableResult<Row> }
client.User.create({ name: "Alice" });
client.User.where({ id: "u1" }).first();
```

Our IDB ORM follows the same pattern:

```ts
import { idbOrm } from "@prisma-idb/client-idb/orm";
import { createIdbRuntime } from "@prisma-idb/runtime-idb/runtime";

const runtime = createIdbRuntime({ adapter, driver, contract });
await runtime.verifyMarker(); // check schema match

const db = idbOrm({ contract, executor: runtime });
await db.users.create({ name: "Alice" });
const users = await db.users.all();
```

### MVP operations (implemented)

- `create` — IDB `add()` operation with client-generated id
- `all` — full cursor scan
- `where` + `first` — cursor scan with in-memory filter
- `findUnique` — exact key lookup
- `delete` — key-based deletion

### What's done in Phase 6 (MVP)

- `create(data)` — IDB `put()` with caller-generated ID
- `all()` — full cursor scan
- `where(filter)` — equality-only in-memory filter (ANDed)
- `first()` — cursor scan taking 1
- `findUnique(key)` — IDB key lookup
- `delete(key)` — single-key IDB delete
- `include(relName)` — batch FK relation load (one level, no refinement). Handles both `1:N` (groups → arrays) and `N:1`/`1:1` (indexes → singles). Short-circuits when all local FK values are null.
- `orderBy(spec)` — in-memory comparator
- `take(n)` / `skip(n)` — inline during cursor scan
- Auto-migration: `createAutoMigratingIdbClient({ contract, dbName, manifest? })` diffs schema, opens IDB at `targetVersion = (manifest.idbVersion ?? currentDbVersion) + 1`, runs DDL in `upgradeneeded`, writes marker (ADR 008 Path A).
- Type-safe builder chain: each method returns a new `IdbStoreAccessorImpl` (immutable). `.include()` widens `TIncludes` so the row return type grows.

### Where the MVP stops short of the vendor pattern

- Driver primitives `IdbUpdatePlan`, `IdbDeletePlan` (key-range), `IdbBatchPlan` exist but no ORM surface uses them yet.
- `IdbBatchPlan` provides single-tx multi-store atomicity at the driver layer, but no `IdbTransactionScope` / `withMutationScope()` exists in `client-idb` (Phase 6.3 still open).
- `IdbCursorScanPlan` supports `indexName` and `range` for index-accelerated scans, but the ORM never sets them — every `where`/`findUnique-by-unique-index` falls through to a full cursor scan with in-memory filter.
- The adapter (`IdbAdapter.lower()`) is a pure passthrough — codec registry and `ctx.contract` are unused. All `idb/*` codecs are identity transforms today so this is functionally correct, but `createIdbClient()` instantiates the adapter with `emptyCodecLookup` instead of pulling the real codecs from `target-idb` — so the codec path is _never_ tested even in principle ([Issue #3]).
- ORM grouping key counter (`_nextGroupingKey`) is module-level, not per-runtime. Two clients in the same JS process share the counter — observable in middleware but not a correctness bug.

[Issue #3]: #issue-3--createidbclient-instantiates-the-adapter-with-emptycodeclookup

---

## Parallel Testing Strategy

Each Phase 6.x implementation step is developed alongside a matching test file in `apps/prisma-orm-usage`. Tests in the demo app provide integration-level coverage (contract → idbOrm → runtime → driver → IDB) that the package unit tests cannot fully cover.

### Mapping: phase → test file

| Phase | `apps/prisma-orm-usage/test/` file(s)                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1   | `filterConditions/operators.spec.ts`, `filterConditions/combinators.spec.ts`                                                                                                                                                                                                                                 |
| 6.2   | `modelQueries/update.spec.ts`, `modelQueries/updateAll.spec.ts`, `modelQueries/updateCount.spec.ts`, `modelQueries/upsert.spec.ts`, `modelQueries/createAll.spec.ts`, `modelQueries/createCount.spec.ts`, `modelQueries/deleteAll.spec.ts`, `modelQueries/deleteCount.spec.ts`, `modelQueries/count.spec.ts` |
| 6.3   | `atomicOperations/multiStoreTransaction.spec.ts`                                                                                                                                                                                                                                                             |
| 6.4   | `nestedWrites/create.spec.ts`, `nestedWrites/connect.spec.ts`, `nestedWrites/disconnect.spec.ts`                                                                                                                                                                                                             |
| 6.5   | `includeRefinement/whereInsideInclude.spec.ts`, `includeRefinement/scalarInclude.spec.ts`                                                                                                                                                                                                                    |
| 6.6   | `modelQueries/aggregate.spec.ts`, `modelQueries/groupBy.spec.ts`                                                                                                                                                                                                                                             |
| 6.7   | `modelQueries/select.spec.ts`                                                                                                                                                                                                                                                                                |

**Already covered** (from demo app setup): `modelQueries/create.spec.ts`, `modelQueries/findFirst.spec.ts`, `modelQueries/findUnique.spec.ts`, `modelQueries/delete.spec.ts`, `filterConditions/equality.spec.ts`, `modelQueryOptions/orderBy.spec.ts`, `modelQueryOptions/take.spec.ts`, `modelQueryOptions/skip.spec.ts`, `nestedQueries/include.spec.ts`.

### Rule

Write the demo app test first (red), then implement the feature in the package (green). The demo app tests exercise the fully assembled stack; package unit tests (`client-idb/test/orm.test.ts`) cover edge cases and internal invariants in isolation.

---

## Phase 6.1 — Filter expression AST + operator API ✅ Done

**Status (2026-05-26):** Shipped. `IdbFilterExpr` (frozen-object AST), `evaluateFilter`, `shorthandToFilterExpr`, the Proxy-based `IdbModelAccessor`, and the `and` / `or` / `not` combinators are all live in `adapter-idb` and `client-idb`. `IdbStoreAccessorImpl.where()` accepts both shorthand (`{ field: value }`, with `null` lifting to a null-check expression) and callback (`(m) => m.field.op(value)`) forms; multiple `.where()` calls compose with AND. The query-runner shell in `apps/prisma-orm-usage` exposes the combinators in the JS sandbox so Playwright specs use the same operator surface end-to-end.

Tests: 18 new vitest cases in `adapter-idb/test/filter-expr.test.ts` (operators, combinators, null-check, shorthand lift) and 13 new client-idb integration tests in `client-idb/test/operators.test.ts` exercising the whole stack through `fake-indexeddb`. The 12 Phase-6.1 Playwright specs in `apps/prisma-orm-usage/tests/operators.spec.ts` cover the same surface against a real Vite preview build.

**Goal:** Replace the equality-only `WhereFilter` with a full expression AST and a typed `IdbModelAccessor` proxy. After this phase a developer can write:

```ts
// Callback form with operators:
await db.posts.where((p) => p.views.gt(100)).all();
await db.users.where((u) => u.name.contains("Alice")).all();
await db.users.where((u) => and(u.age.gte(18), u.active.eq(true))).all();

// Shorthand still works (equality only, unchanged):
await db.users.where({ active: true }).all();
```

### Reference

Mongo ORM: `MongoFieldFilter`, `MongoAndExpr`, `MongoOrExpr`, `MongoNotExpr` (class-based frozen nodes).
SQL ORM: `BinaryExpr`, `AndExpr`, `OrExpr` from `sql-relational-core/ast` (class-based, codec trait-gated).

**IDB adaptation**: use **plain frozen objects** (not classes) — no visitor pattern needed, no codec traits. `evaluateFilter()` is a simple recursive function. All operators are always available on all fields (IDB stores native JS values, so numeric vs string comparison is governed by JS semantics, not codec metadata).

### New: `IdbFilterExpr` discriminated union (`adapter-idb/src/core/idb-filter-expr.ts`)

```ts
export type IdbFilterOp =
  "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "in" | "notIn" | "contains" | "startsWith" | "endsWith";

export interface IdbFieldFilter {
  readonly kind: "field";
  readonly field: string;
  readonly op: IdbFilterOp;
  readonly value: unknown;
}
export interface IdbAndExpr {
  readonly kind: "and";
  readonly exprs: ReadonlyArray<IdbFilterExpr>;
}
export interface IdbOrExpr {
  readonly kind: "or";
  readonly exprs: ReadonlyArray<IdbFilterExpr>;
}
export interface IdbNotExpr {
  readonly kind: "not";
  readonly expr: IdbFilterExpr;
}
export interface IdbNullCheckExpr {
  readonly kind: "null-check";
  readonly field: string;
  readonly isNull: boolean;
}

export type IdbFilterExpr = IdbFieldFilter | IdbAndExpr | IdbOrExpr | IdbNotExpr | IdbNullCheckExpr;

// Factory helpers used by IdbFieldAccessor and shorthandToFilterExpr:
export const fieldFilter = (field: string, op: IdbFilterOp, value: unknown): IdbFieldFilter =>
  Object.freeze({ kind: "field", field, op, value });
export const andExpr = (exprs: ReadonlyArray<IdbFilterExpr>): IdbAndExpr =>
  Object.freeze({ kind: "and", exprs: Object.freeze([...exprs]) });
export const orExpr = (exprs: ReadonlyArray<IdbFilterExpr>): IdbOrExpr =>
  Object.freeze({ kind: "or", exprs: Object.freeze([...exprs]) });
export const notExpr = (expr: IdbFilterExpr): IdbNotExpr => Object.freeze({ kind: "not", expr });
export const nullCheckExpr = (field: string, isNull: boolean): IdbNullCheckExpr =>
  Object.freeze({ kind: "null-check", field, isNull });
```

### New: `evaluateFilter(expr, row)` (`adapter-idb/src/core/filter-eval.ts`)

Recursive function — no visitor. Used in `store-accessor.ts` to build the `IdbRowFilter` closure passed to the driver plan. The driver's `IdbRowFilter` type stays as `(row) => boolean`; the filter closure calls `evaluateFilter(combinedExpr, row)`.

```ts
export function evaluateFilter(expr: IdbFilterExpr, row: Record<string, unknown>): boolean;
```

String ops (`contains`, `startsWith`, `endsWith`) coerce field values with `String()` before comparing. `in`/`notIn` use `===` per element. All comparison ops use JS `<`/`>`/`<=`/`>=`.

### New: `shorthandToFilterExpr` helper (`adapter-idb/src/core/idb-filter-expr.ts`)

Mirrors `shorthandToWhereExpr` from `sql-orm-client/filters.ts`:

```ts
export function shorthandToFilterExpr(filters: Record<string, unknown>): IdbFilterExpr | undefined {
  const exprs: IdbFilterExpr[] = [];
  for (const [field, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (value === null) {
      exprs.push(nullCheckExpr(field, true));
      continue;
    }
    exprs.push(fieldFilter(field, "eq", value));
  }
  if (exprs.length === 0) return undefined;
  return exprs.length === 1 ? exprs[0] : andExpr(exprs);
}
```

### New: `IdbModelAccessor` proxy (`client-idb/src/core/model-accessor.ts`)

Mirrors `createModelAccessor()` from `sql-orm-client` but **without codec trait-gating**. A `Proxy` keyed on field names; each field returns an `IdbFieldAccessor<T>`:

```ts
// The typed surface (compile-time):
export type IdbFieldAccessor<T> = {
  eq(value: T): IdbFilterExpr;
  neq(value: T): IdbFilterExpr;
  gt(value: T): IdbFilterExpr;
  lt(value: T): IdbFilterExpr;
  gte(value: T): IdbFilterExpr;
  lte(value: T): IdbFilterExpr;
  in(values: T[]): IdbFilterExpr;
  notIn(values: T[]): IdbFilterExpr;
  contains(sub: string): IdbFilterExpr; // all fields (coerces to string at eval time)
  startsWith(sub: string): IdbFilterExpr;
  endsWith(sub: string): IdbFilterExpr;
  isNull(): IdbFilterExpr;
  isNotNull(): IdbFilterExpr;
};

// At runtime the Proxy get-trap creates this for any field name:
function createIdbFieldAccessor(field: string): IdbFieldAccessor<unknown> {
  return {
    eq: (value) => fieldFilter(field, "eq", value),
    neq: (value) => fieldFilter(field, "neq", value),
    gt: (value) => fieldFilter(field, "gt", value),
    lt: (value) => fieldFilter(field, "lt", value),
    gte: (value) => fieldFilter(field, "gte", value),
    lte: (value) => fieldFilter(field, "lte", value),
    in: (values) => fieldFilter(field, "in", values),
    notIn: (values) => fieldFilter(field, "notIn", values),
    contains: (sub) => fieldFilter(field, "contains", sub),
    startsWith: (sub) => fieldFilter(field, "startsWith", sub),
    endsWith: (sub) => fieldFilter(field, "endsWith", sub),
    isNull: () => nullCheckExpr(field, true),
    isNotNull: () => nullCheckExpr(field, false),
  };
}

// ModelAccessor<TContract, ModelName> maps each scalar field key → IdbFieldAccessor<FieldType>
export type IdbModelAccessor<TContract, ModelName extends string> = {
  readonly [K in keyof DefaultModelRow<TContract, ModelName>]: IdbFieldAccessor<
    DefaultModelRow<TContract, ModelName>[K]
  >;
};

export function createModelAccessor<TContract extends IdbContract, ModelName extends string>(): IdbModelAccessor<
  TContract,
  ModelName
> {
  return new Proxy({} as IdbModelAccessor<TContract, ModelName>, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== "string") return undefined;
      return createIdbFieldAccessor(prop);
    },
  });
}
```

### New: `and()`, `or()`, `not()` user-facing helpers (`client-idb/src/core/filters.ts`)

```ts
export const and = (...exprs: IdbFilterExpr[]): IdbAndExpr => andExpr(exprs);
export const or = (...exprs: IdbFilterExpr[]): IdbOrExpr => orExpr(exprs);
export const not = (expr: IdbFilterExpr): IdbNotExpr => notExpr(expr);
```

### Changes to existing files

| File                             | Change                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store-state.ts`                 | `filters: ReadonlyArray<IdbFilterExpr>` (was `ReadonlyArray<Record<string, unknown>>`)                                                                                                                        |
| `store-accessor.ts`              | `where()` gains overload: `where(fn: (m: IdbModelAccessor<TContract, ModelName>) => IdbFilterExpr)`. Shorthand object form converts via `shorthandToFilterExpr()`. `#buildFilter()` calls `evaluateFilter()`. |
| `idb-query-ast.ts`               | `IdbFindManyAst.where` type → `IdbFilterExpr` (was `Record<string, unknown>`)                                                                                                                                 |
| `adapter-idb/exports/runtime.ts` | Re-export `IdbFilterExpr`, `IdbFieldFilter`, etc. and `evaluateFilter`                                                                                                                                        |
| `client-idb/exports/orm.ts`      | Re-export `IdbModelAccessor`, `IdbFieldAccessor`, `and`, `or`, `not`                                                                                                                                          |

> **Note**: `IdbRowFilter` on `IdbCursorScanPlan` stays as `(row) => boolean`. The accessor builds the closure using `evaluateFilter()` — the driver does not import `IdbFilterExpr`. This keeps `driver-idb` free of `adapter-idb` dependencies.

---

## Phase 6.2 — Missing CRUD terminals ✅ Done

**Status (2026-05-26):** Shipped. Vendor naming (`updateAll/updateCount`, `createAll/createCount`, `deleteAll/deleteCount`) adopted instead of the original `updateMany/createMany/deleteMany` sketch. `IdbScanWritePlan` (readwrite cursor, put-merged or delete) and `IdbBatchPlan` (N puts in one tx) handle the driver layer. 9 new ORM terminals on `IdbStoreAccessorImpl`. 43 new Playwright E2E specs across 9 files all pass. **Known gap:** `.where()` before `update`/`updateAll`/`updateCount`/`deleteAll`/`deleteCount` is not enforced at compile time — the SQL ORM vendor achieves this via a state-machine type parameter, deferred to a post-6.2 type-level refactor.

**Goal:** Close the gap on the most-needed write operations. After this phase:

```ts
// update — first matching row (requires .where())
await db.users.where({ id: "u1" }).update({ displayName: "New Name" }); // → Row | null

// updateAll — all matching rows returned (requires .where())
const rows = await db.users.where((u) => u.active.eq(false)).updateAll({ archivedAt: new Date() });

// updateCount — count of updated rows (requires .where())
const n = await db.users.where((u) => u.active.eq(false)).updateCount({ archivedAt: new Date() });

// upsert
await db.users.upsert({
  create: { id: "u1", name: "Alice" },
  update: { name: "Alice Updated" },
  where: { id: "u1" },
});

// createAll — batch insert, returns all inserted rows
const rows = await db.posts.createAll([{ title: "Post A" }, { title: "Post B" }]);

// createCount — batch insert, returns count only
const n = await db.posts.createCount([{ title: "Post A" }, { title: "Post B" }]);

// deleteAll — deletes matching rows, returns deleted rows
const deleted = await db.users.where({ active: false }).deleteAll();

// deleteCount — deletes matching rows, returns count
const n = await db.users.where({ active: false }).deleteCount();

// count — count matching rows (0 filters = count all)
const total = await db.users.where({ active: true }).count();
```

### Reference

SQL ORM: `compileUpdateReturning` (`updateAll`), `compileUpdateCount` (`updateCount`), `compileDeleteCount` (`deleteCount`), `compileDeleteReturning` (`deleteAll`), `compileBatchInsert` (`createAll/createCount`). IDB equivalent: `IdbScanWritePlan` (readwrite cursor, `put-merged` or `delete`) + `IdbBatchPlan` (N `put` ops in one tx). `updateAll`/`deleteAll` both return rows (vendor uses `RETURNING`; IDB captures row before `cursor.delete()` and echoes merged row after `cursor.update()`).

### Changes to `IdbStoreAccessorImpl` (`store-accessor.ts`)

**New terminals (all use the existing cursor-scan infrastructure):**

| Method                              | Driver plan(s)                                                                 | Returns                    |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------- |
| `update(patch)`                     | `IdbScanWritePlan { write:"put-merged", take:1 }` + accumulated filter         | `Row \| null`              |
| `updateAll(patch)`                  | `IdbScanWritePlan { write:"put-merged" }` + accumulated filter                 | `AsyncIterableResult<Row>` |
| `updateCount(patch)`                | delegates to `updateAll(patch).toArray().length`                               | `number`                   |
| `upsert({ create, update, where })` | `first()` with where filter → `IdbPutPlan` (insert) or `IdbUpdatePlan` (merge) | `Row`                      |
| `createAll(data[])`                 | `IdbBatchPlan` with N `IdbPutPlan` ops                                         | `AsyncIterableResult<Row>` |
| `createCount(data[])`               | delegates to `createAll(data).toArray().length`                                | `number`                   |
| `deleteAll()`                       | `IdbScanWritePlan { write:"delete" }` + accumulated filter                     | `AsyncIterableResult<Row>` |
| `deleteCount()`                     | delegates to `deleteAll().toArray().length`                                    | `number`                   |
| `count()`                           | existing `cursor-scan` plan, drains without collecting                         | `number`                   |

**New driver-side plan kind** added to `driver-idb/src/core/plan-body.ts`:

```ts
// readwrite cursor scan — put-merged or delete per matching row
type IdbScanWritePlan = {
  kind: "scan-write";
  storeName: string;
  filter?: IdbRowFilter;
  take?: number; // 1 for update(), undefined for updateAll/deleteAll
  write: "put-merged" | "delete";
  patch?: Record<string, unknown>; // required when write === "put-merged"
};
```

Added to `IdbAtomicPlan` and dispatched in `execute/ops.ts`. `planTxMode()` returns `"readwrite"` for `"scan-write"`.

**New AST nodes** (`adapter-idb/src/core/idb-query-ast.ts`):

```ts
type IdbUpdateAst = { kind: "update"; modelName: string; patch: Record<string, unknown>; where?: IdbFilterExpr };
type IdbUpdateAllAst = { kind: "updateAll"; modelName: string; patch: Record<string, unknown>; where?: IdbFilterExpr };
type IdbUpdateCountAst = {
  kind: "updateCount";
  modelName: string;
  patch: Record<string, unknown>;
  where?: IdbFilterExpr;
};
type IdbUpsertAst = {
  kind: "upsert";
  modelName: string;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  where: Record<string, unknown>;
};
type IdbCreateAllAst = { kind: "createAll"; modelName: string; data: Record<string, unknown>[] };
type IdbCreateCountAst = { kind: "createCount"; modelName: string; data: Record<string, unknown>[] };
type IdbDeleteAllAst = { kind: "deleteAll"; modelName: string; where?: IdbFilterExpr };
type IdbDeleteCountAst = { kind: "deleteCount"; modelName: string; where?: IdbFilterExpr };
type IdbCountAst = { kind: "count"; modelName: string; where?: IdbFilterExpr };
```

### Known gap — `.where()` compile-time enforcement

The SQL ORM vendor enforces `.where()` before `update/updateAll/updateCount/deleteAll/deleteCount` at **compile time** via a state-machine type parameter. Our `IdbStoreAccessor` does not yet carry this parameter — calling `updateAll(patch)` without `.where()` updates every row (equivalent to `UPDATE table SET ...` with no WHERE). This is correct runtime behavior; the type system just doesn't warn about it. Deferred to a post-6.2 type-level refactor.

---

## Phase 6.3 — Multi-store transaction support ✅ Done

**Status (2026-05-26):** Shipped. `IdbTransactionScope` (interface + `IdbTransactionScopeImpl`) + `createTransactionScope()` factory live in `driver-idb/src/core/transaction-scope.ts`. `withMutationScope()` + `IdbQueryExecutorWithTransaction` live in `client-idb/src/core/mutation-scope.ts`. `IdbRuntime.transaction()` delegates to `driver.db` + `createTransactionScope()`. Issue #6 resolved: scope operations bypass the middleware chain, so the cache middleware never incorrectly fires inside a transaction.

**Goal:** Allow multiple stores to be written atomically. Required before Phase 6.4 (nested writes across stores).

### Reference

SQL ORM: `withMutationScope()` in `mutation-executor.ts` calls `runtime.transaction()` to get a `RuntimeScope`, runs the callback, then `commit()` or `rollback()` on error. Identical pattern for IDB.

### Mental model

IDB transactions span one or more object stores named at open time. All requests inside the transaction either fully commit or fully roll back. `IdbTransactionScope.execute(plan)` runs `executeOpInTx` directly inside the pre-opened `IDBTransaction` — no new transaction is opened per call. `commit()` returns a Promise that resolves when `tx.oncomplete` fires (all writes durable). `rollback()` calls `tx.abort()`.

Transaction liveness across `await` boundaries: `IDBTransaction` auto-commits only in a macro-task (not a microtask). Since `await` resumes via a microtask, issuing the next `scope.execute()` call immediately after an `await` keeps the transaction alive. The standard `withMutationScope` usage pattern never crosses a macro-task boundary.

### New: `IdbTransactionScope` (`driver-idb/src/core/transaction-scope.ts`)

```ts
export interface IdbTransactionScope {
  execute(plan: IdbAtomicPlan): Promise<Record<string, unknown>[]>;
  commit(): Promise<void>; // resolves when tx.oncomplete fires
  rollback(): void; // calls tx.abort() (idempotent — ignores already-aborted)
}
```

`IdbRuntimeDriverInstance` gains `transaction(storeNames: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope>` (async because `driver.db` is a `Promise<IDBDatabase>`).

### New: `withMutationScope()` (`client-idb/src/core/mutation-scope.ts`)

```ts
export async function withMutationScope<T>(
  executor: IdbQueryExecutorWithTransaction,
  storeNames: string[],
  run: (scope: IdbTransactionScope) => Promise<T>
): Promise<T> {
  const tx = await executor.transaction(storeNames, "readwrite");
  try {
    const result = await run(tx);
    await tx.commit();
    return result;
  } catch (err) {
    tx.rollback();
    throw err;
  }
}
```

`IdbQueryExecutorWithTransaction` extends `IdbQueryExecutor` with `transaction(storeNames, mode?): Promise<IdbTransactionScope>`. `IdbRuntime` satisfies it by delegating to `driver.db` + `createTransactionScope()`.

---

## Phase 6.4 — Nested relation writes (create / connect / disconnect)

**Goal:** `create()` and `update()` accept relation fields as callback mutators. Requires Phase 6.3 (transaction scope).

```ts
// Nested create
await db.users.create({
  id: "u1",
  name: "Alice",
  posts: (rel) => rel.create([{ title: "Post 1" }, { title: "Post 2" }]),
});

// Nested connect
await db.users.where({ id: "u1" }).update({
  profile: (rel) => rel.connect({ id: "p1" }),
});

// Nested disconnect
await db.users.where({ id: "u1" }).update({
  profile: (rel) => rel.disconnect(),
});
```

### Reference

`sql-orm-client/relation-mutator.ts` — `createRelationMutator()`, `isRelationMutationDescriptor()`, `isRelationMutationCallback()`.
`sql-orm-client/mutation-executor.ts` — `parseMutationInput`, `partitionByOwnership`, `createGraph`, `updateFirstGraph`, `withMutationScope`.

**IDB adaptations vs SQL ORM:**

- No `RETURNING` clause — echo input record after `put` (already done in `IdbPutPlan`)
- After nested `update`, re-read via `key-get` to get the merged result (IDB `IdbUpdatePlan` already echoes merged record)
- `connect` for child-owned: find the related row by criterion (cursor-scan + filter), then `put` it with the FK set to the parent key — no SQL `UPDATE SET` needed
- `disconnect` for N:1: set the FK field to `null` in scalar data before insert/update
- Store names for `withMutationScope` are collected by walking the relation graph at parse time

### New: `IdbRelationMutator` (`client-idb/src/core/relation-mutator.ts`)

Direct port of `sql-orm-client/relation-mutator.ts`. Same `createRelationMutator()`, `isRelationMutationDescriptor()`, `isRelationMutationCallback()` functions — just different type imports.

```ts
export interface IdbRelationMutator<TContract, ModelName extends string> {
  create(data: CreateInput<TContract, ModelName> | CreateInput<TContract, ModelName>[]): RelationMutationCreate;
  connect(criteria: Record<string, unknown> | Record<string, unknown>[]): RelationMutationConnect;
  disconnect(criteria?: Record<string, unknown>[]): RelationMutationDisconnect;
}
```

### New: `IdbMutationExecutor` (`client-idb/src/core/mutation-executor.ts`)

Port of `sql-orm-client/mutation-executor.ts`:

| Function                                                      | IDB adaptation                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `parseMutationInput(contract, modelName, data)`               | Splits scalar fields from relation callbacks (identical logic)                 |
| `partitionByOwnership(mutations)`                             | N:1 → parentOwned; 1:N / 1:1 → childOwned (identical logic)                    |
| `createGraph(scope, contract, modelName, data)`               | Inserts via `scope.execute({ kind: 'put', ... })`; echoes record               |
| `updateFirstGraph(scope, contract, modelName, filters, data)` | Finds row by filter, merges patch via `scope.execute({ kind: 'update', ... })` |
| `hasNestedMutationCallbacks(contract, modelName, data)`       | Same check — any relation field that `isRelationMutationCallback`              |

### Changes to `IdbStoreAccessorImpl`

`create()` and `update()` detect relation callbacks via `hasNestedMutationCallbacks()`. When detected, wrap in `withMutationScope()` (collecting all required store names from the contract's relation graph).

Phase 6.4's `connect()` validates FK existence for parent-owned nested writes. Full scalar FK validation and referential action enforcement on delete are implemented in [Phase 6.8](#phase-68--fk-validation-and-referential-action-enforcement).

---

## Phase 6.5 — Include refinement

> **Status: ✅ Done (2026-06-02).** See [§ Phase 6.5–6.7](#phase-65-67-include-refinement-aggregate-select-2026-06-02) for the as-built summary. The design below is the original plan; it was implemented largely as written.

**Goal:** `include()` accepts an optional refinement callback. After this phase:

```ts
// Refined include with filter + pagination
const users = await db.users
  .include("posts", (posts) => posts.where({ published: true }).orderBy({ createdAt: "desc" }).take(5))
  .all();

// Scalar include (count of related records)
const users = await db.users.include("posts", (posts) => posts.count()).all();
```

### Reference

`sql-orm-client/collection.ts` `include()` overload: `refineFn?` receives a child `Collection` and may return a refined `Collection` or an `IncludeScalar`. `isIncludeScalar()` / `isCollectionStateCarrier()` from `include-descriptors.ts` distinguish scalar vs collection refinement.

`sql-orm-client/include-strategy.ts` — dispatches includes using the refined collection state (filters/orderBy/take). IDB equivalent: use the refined `IdbAccessorState` directly to build the child cursor-scan plan.

### Changes to `include()` signature

```ts
include<K extends ReferenceRelKeys<TContract, ModelName>>(
  relation: K,
  refineFn?: (
    collection: IdbStoreAccessor<TContract, RelatedModelName>
  ) => IdbStoreAccessor<TContract, RelatedModelName> | IdbIncludeScalar,
): IdbStoreAccessor<TContract, ModelName, TIncludes & { [P in K]: RelationResult }>
```

`IdbIncludeScalar` is a thin marker object returned by `.count()` terminal (when called in refinement context):

```ts
interface IdbIncludeScalar {
  readonly kind: "scalar";
  readonly fn: "count";
}
```

### Changes to `relation-loader.ts`

The relation loader currently uses a fixed cursor-scan to load all FK-matching records. With refinement, it uses the `IdbAccessorState` returned by `refineFn` to build the sub-plan (inheriting filters, orderBy, take from the refined accessor).

For scalar reduces (`count()`), the loader counts matching rows rather than materializing them.

Include state in `IdbAccessorState` changes from `Record<string, true>` to:

```ts
type IncludeEntry =
  { readonly kind: "collection"; readonly state: IdbAccessorState } | { readonly kind: "scalar"; readonly fn: "count" };
```

---

## Phase 6.6 — Aggregate / groupBy

> **Status: ✅ Done (2026-06-02).** See [§ Phase 6.5–6.7](#phase-65-67-include-refinement-aggregate-select-2026-06-02) for the as-built summary. The design below is the original plan; it was implemented largely as written.

**Goal:** Standalone aggregation and grouped aggregation. All in-memory (IDB has no aggregation API).

```ts
// Full aggregate
const stats = await db.posts.where({ published: true }).aggregate((agg) => ({
  total: agg.count(),
  totalViews: agg.sum("views"),
  avgViews: agg.avg("views"),
}));

// Grouped aggregate
const byUser = await db.posts
  .where({ published: true })
  .groupBy("authorId")
  .aggregate((agg) => ({ count: agg.count(), totalViews: agg.sum("views") }));
```

### Reference

`sql-orm-client/grouped-collection.ts` `GroupedCollection.aggregate()` — materializes rows, groups, runs aggregate functions. IDB uses the same pattern but purely in-memory (no SQL compilation).

`sql-orm-client/aggregate-builder.ts` — `createAggregateBuilder()` returns `{ count(), sum(field), avg(field), min(field), max(field) }`. Each returns an `AggregateSelector` marker with a `fn` tag and optional `field`. IDB version is identical minus the SQL AST.

`coerceAggregateValue(fn, value)` from `grouped-collection.ts` — handles bigint, string-encoded numbers, null, undefined for count. Port directly.

### New: `IdbGroupedAccessor` (`client-idb/src/core/grouped-accessor.ts`)

Port of `GroupedCollection`. The `aggregate()` terminal:

1. Materializes all matching rows via the base accessor's `all().toArray()`
2. Groups in-memory by the `groupBy` field(s)
3. Computes aggregate selectors per group
4. Returns typed result rows (group fields + aggregate aliases)

### New: `IdbAggregateBuilder` (`client-idb/src/core/aggregate-builder.ts`)

```ts
interface IdbAggregateSelector<T> {
  readonly fn: "count" | "sum" | "avg" | "min" | "max";
  readonly field?: string;
}

function createAggregateBuilder<TContract, ModelName>(): IdbAggregateBuilder<TContract, ModelName> {
  return {
    count: () => ({ fn: "count" }),
    sum: (field) => ({ fn: "sum", field }),
    avg: (field) => ({ fn: "avg", field }),
    min: (field) => ({ fn: "min", field }),
    max: (field) => ({ fn: "max", field }),
  };
}
```

### New standalone `aggregate()` terminal on `IdbStoreAccessor`

In addition to `groupBy().aggregate()`, the accessor itself gains `.aggregate()` for non-grouped aggregation:

```ts
aggregate<Spec extends Record<string, IdbAggregateSelector<unknown>>>(
  fn: (agg: IdbAggregateBuilder<TContract, ModelName>) => Spec
): Promise<AggregateResult<Spec>>
```

This is a pure in-memory reduce over the matching rows (same as `count()` for Phase 6.2, generalized).

---

## Phase 6.7 — Select projection

> **Status: ✅ Done (2026-06-02).** See [§ Phase 6.5–6.7](#phase-65-67-include-refinement-aggregate-select-2026-06-02) for the as-built summary. The design below is the original plan; it was implemented largely as written.

**Goal:** `select()` narrows the row shape returned. Post-materialization in-memory projection (IDB stores whole records).

```ts
const summaries = await db.users.select("id", "email").all();
// typeof summaries[0] === { id: string; email: string }
```

### Reference

`sql-orm-client/selection-shaping.ts` — `augmentSelectionForJoinColumns` adds join columns for relation loads. IDB equivalent is simpler: just strip non-selected fields from materialized rows after cursor-scan and after relation loads.

`sql-orm-client` collection type state carries `WithSelectState` tracking selected fields. IDB follows the same pattern: `IdbAccessorState.selectedFields?: ReadonlyArray<string>`.

### Changes to `IdbStoreAccessorImpl`

`select(...fields)` stores the field list in `IdbAccessorState.selectedFields`. After cursor-scan materialization and after relation loads, a projection step strips non-selected fields via `Object.fromEntries(selectedFields.map(f => [f, row[f]]))`.

The return type narrows: `select('id', 'email')` changes `Row` to `Pick<DefaultModelRow<...>, 'id' | 'email'>`.

**Important**: `selectedFields` must be augmented with FK columns needed by any pending `include()` loads before projection. This mirrors what `augmentSelectionForJoinColumns` does in sql-orm-client. The projection step is applied after all relation loads complete.

---

## Phase 8 — `contract infer`

**Goal:** Make `Prisma ORM contract infer` work for IDB by implementing the `PslContractInferCapable` capability on the family descriptor. Currently the CLI returns `"contract infer is not supported for this family"`.

**What it does:** Reads `manifest.schema.stores` (the live IDB schema as the manifest driver sees it) and emits a PSL-like contract definition that mirrors that schema. Useful for bootstrapping a contract from an existing IDB database, or for inspecting what schema the CLI currently sees.

**Implementation sketch:**

The family descriptor needs to gain the `PslContractInferCapable` capability. This involves:

1. `family-idb/src/core/control-descriptor.ts` — add `PslContractInferCapable` to the descriptor's capability list.
2. New `inferContract(driver)` implementation that:
   - Calls `introspect(driver)` to get `manifest.schema` (already implemented)
   - Converts each `IdbStoreIR` into a `ModelDef`-like representation (store name, keyPath, indexes)
   - Outputs a synthetic `defineContract(...)` call or equivalent PSL block

**Constraints:**

- IDB cannot infer field types — `manifest.schema` stores only store/index structure, not the shape of records stored in each store. The output would produce `fields: {}` for each model (or omit fields) and the user would need to add them manually.
- Unlike SQL/Mongo, there is no "live database" to connect to from Node.js — the manifest file IS the schema source. So this is pure manifest → contract translation, not a live introspection.
- The output format follows whatever `Prisma ORM contract infer` emits for SQL families (PSL or JSON) — check the framework's `PslContractInferCapable` interface for the expected return type.

---

## Phase 6.8 — FK validation and referential action enforcement

**Goal:** Eliminate dangling FK references. Every write that touches a FK field must validate the referenced record exists; every delete must enforce the declared `onDelete` action on child records. See [ADR 009](docs/adrs/ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md).

### Reference

Legacy `packages/generator/src/fileCreators/.../api/delete.ts` — full cascade/setNull/setDefault/restrict implementation via Prisma DMMF `field.relationOnDelete`. The pattern is identical; the data source changes from DMMF to `IdbModelStorage.relations`.

SQL ORM: referential actions are enforced at the database level via DDL (`ON DELETE CASCADE`). IDB has no equivalent, so the ORM must enforce them explicitly — same as MongoDB.

### Step 1 — Extend `IdbModelStorage` (`target-idb/src/core/idb-contract-types.ts`)

```ts
export type IdbReferentialAction = "cascade" | "setNull" | "setDefault" | "restrict" | "noAction";

export type IdbRelationStorage = {
  readonly onDelete?: IdbReferentialAction; // omitted = 'restrict'
};

// Add to IdbModelStorage:
export type IdbModelStorage = {
  readonly storeName: string;
  readonly keyPath: string;
  readonly relations?: Record<string, IdbRelationStorage>; // keyed by relation name
};
```

Export `IdbReferentialAction` and `IdbRelationStorage` from `target-idb/src/exports/pack.ts`.

### Step 2 — Expose `onDelete` in `RelationDef` (`family-idb/src/core/contract-builder.ts`)

```ts
export type RelationDef = {
  readonly to: string;
  readonly cardinality: "1:1" | "1:N" | "N:1";
  readonly on: { readonly local: readonly string[]; readonly target: readonly string[] };
  readonly onDelete?: IdbReferentialAction; // new; omitted = 'restrict'
};
```

Update `buildModels()` (and the `storage` assembly) to write `onDelete` into `IdbModelStorage.relations[relName]` when specified.

### Step 3 — Scalar FK validation on create/update (`client-idb/src/core/mutation-executor.ts`)

Add `validateScalarForeignKeys(scope, contract, modelName, scalarData)`:

1. For every N:1 relation on `modelName` (where the local model holds the FK): check whether `localFields[0]` is present and non-null in `scalarData`.
2. If yes, open a cursor-scan on the related store filtered by the FK value against `targetFields[0]`.
3. If no matching row is found, throw `"FK validation failed: no <RelatedModel> with <targetField>='<value>'"`.

Call this from `insertSingleRow` and `updateFirstGraph` before the `put`/`update` plan is executed. Since these already run inside `withMutationScope` for nested writes, the related store must be included in the store list collected by `collectStoreNames`.

Update `collectStoreNames` to also include stores for N:1 relations whose FK fields appear in the scalar data (non-null).

### Step 4 — Referential action enforcement on delete (`client-idb/src/core/mutation-executor.ts`)

Add `executeNestedDeleteMutation(options: { executor, contract, modelName, key })`:

1. Walk all relations on `modelName` to find **child** models — 1:N relations where `cardinality === '1:N'` (the related model holds the FK pointing back to this one).
2. For each child relation, read `(contractModels(contract)[modelName].storage as IdbModelStorage).relations?.[relName]?.onDelete ?? 'restrict'`.
3. Based on the action:
   - **`cascade`**: `scope.execute({ kind: 'scan-write', write: 'delete', ... })` on the child store, filtered by the parent FK value.
   - **`setNull`**: `scope.execute({ kind: 'scan-write', write: 'put-merged', patch: { [fkField]: null }, ... })` on the child store.
   - **`setDefault`**: `scope.execute({ kind: 'scan-write', write: 'put-merged', patch: { [fkField]: <default> }, ... })`. IDB has no server-side defaults; for Phase 6.8, emit a runtime error if `setDefault` is declared without a way to derive the default — defer default-value support to a follow-up.
   - **`restrict`** (default when `onDelete` is omitted): cursor-scan the child store; if any rows are found, throw `"Cannot delete <Model>: <ChildModel> records still reference it"`.
   - **`noAction`**: skip — proceed without touching child records. Caller explicitly accepts responsibility for orphaned FKs.
4. Collect all affected child store names upfront; wrap everything in `withMutationScope(executor, [parentStore, ...childStores], ...)`.

Update `store-accessor.ts` `delete()` / `deleteAll()` / `deleteCount()` to call `executeNestedDeleteMutation` when the model has any 1:N relations. The check is cheap (one `getRelationDefinitions` call, same cache used by Phase 6.4).

For `deleteAll()` / `deleteCount()`: apply referential actions per deleted row inside the same multi-store transaction (iterate the matching rows, run `executeNestedDeleteMutation` for each within the scope).

### Step 5 — Tests

**`client-idb/test/referential-actions.test.ts`** (new, via `fake-indexeddb`):

| Test                                            | What it covers                                       |
| ----------------------------------------------- | ---------------------------------------------------- |
| `cascade` — deleting parent deletes children    | `onDelete: 'cascade'` on a 1:N relation              |
| `cascade` — parent with no children             | `delete()` succeeds cleanly                          |
| `cascade` — only related children deleted       | Multiple parents; only the target's children cascade |
| `setNull` — FK set to null on parent delete     | `onDelete: 'setNull'`                                |
| `restrict` — throws when children exist         | `onDelete: 'restrict'`                               |
| `restrict` — succeeds when no children          | `onDelete: 'restrict'`, no dependents                |
| Scalar FK validation — rejects bad FK on create | Non-existent referenced record throws                |
| Scalar FK validation — accepts valid FK         | Referenced record exists; create succeeds            |
| Scalar FK validation — null FK skips check      | `userId: null` is valid (optional relation)          |
| `deleteAll` with cascade                        | Multiple rows deleted; children cascade per row      |

**`apps/prisma-orm-usage/tests/referentialActions/`** (new Playwright spec files):

- `cascade.spec.ts`
- `restrict.spec.ts`

Mirror the pattern from `apps/usage/tests/schema/ReferentialActions/` (the legacy generator's existing coverage).

### Demo app schema

Add a `@relation(onDelete: Cascade)` relation to the demo app's Prisma schema (or equivalent `RelationDef` in `defineContract()`), regenerate the contract, and wire up the Playwright specs.

### Files changed

| File                                                       | Change                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `target-idb/src/core/idb-contract-types.ts`                | Add `IdbReferentialAction`, `IdbRelationStorage`; extend `IdbModelStorage`                 |
| `target-idb/src/exports/pack.ts`                           | Re-export new types                                                                        |
| `family-idb/src/core/contract-builder.ts`                  | Add `onDelete?` to `RelationDef`; write into `IdbModelStorage.relations`                   |
| `client-idb/src/core/mutation-executor.ts`                 | Add `validateScalarForeignKeys`, `executeNestedDeleteMutation`; update `collectStoreNames` |
| `client-idb/src/core/store-accessor.ts`                    | Update `delete()` / `deleteAll()` / `deleteCount()` to call `executeNestedDeleteMutation`  |
| `client-idb/test/referential-actions.test.ts`              | New — vitest coverage via `fake-indexeddb`                                                 |
| `apps/prisma-orm-usage/tests/referentialActions/*.spec.ts` | New — Playwright integration specs                                                         |

---

## Phase 7 — Outbox sync

**Goal:** Bidirectional sync on top of the runtime.

Port the existing sync work from the generator to the new architecture:

- Outbox on the client, changelog materialization on the server
- Ownership DAG validation (the 4 core invariants from todo.md)

## Review findings (2026-05-25)

Audit comparing our six packages against the vendor reference implementation (`vendor/prisma-next/packages/2-mongo-family/*`, `2-sql/*`, `3-extensions/sql-orm-client/`, `3-extensions/mongo/`). What follows is **just the gaps not already enumerated in Phase 6.1-6.7**.

### ✅ Issue #1 — `MigrationRunner` missing `executeAcrossSpaces`, blocks CLI `db update` — FIXED

`executeAcrossSpaces` was implemented in [migration-runner.ts](packages/prisma-orm/target-idb/src/core/migration-runner.ts). The CLI path B (all `db` subcommands) is now fully operational. The implementation also adds a fake-indexeddb DDL dry-run (with the manifest schema pre-seeded so drop ops are verifiable), a storageHash short-circuit so idempotent calls are no-ops, and writes `idbVersion` + `schema` back to the manifest on success.

### ✅ Issue #2 — `sign()` does not populate `manifest.schema` from contract — FIXED

`sign()` now writes `schema: schemaFromContract(contract)` ([control-instance.ts](packages/prisma-orm/family-idb/src/core/control-instance.ts)) instead of preserving the old (potentially empty) schema. `db update` also writes the schema on success via `executeAcrossSpaces`, so both paths are consistent.

### ✅ Issue #3 — `createIdbClient` instantiates the adapter with `emptyCodecLookup` — FIXED

`idb-client.ts` now imports and uses `idbCodecLookup` from `@prisma-idb/target-idb/runtime` instead of `emptyCodecLookup`. The real codec lookup is wired through the full stack.

### ✅ Issue #4 — Missing stores treated as warnings in lenient schema verify — FIXED

`schema-verify.ts` now always emits `failNode` for a missing store regardless of `strict` mode. The `strict` flag governs only _extra_ entries not in the contract. The previously failing test now passes (family-idb: 60/60).

### ✅ Issue #5 — No `runtime-idb` test for streaming row coalescence with `onRow` middleware — DOCUMENTED

Not a code bug — the collect-then-yield behavior is a correct and unavoidable consequence of IDB's transaction model (ADR 006). The implications for middleware authors are now documented:

- **ADR 006** gained a "Middleware implications" section explaining why `onRow` backpressure doesn't reduce IDB reads, when to use `take(n)` instead, and how this diverges from the framework's streaming assumption.
- **`IdbMiddleware`** (`runtime-idb/src/idb-middleware.ts`) has an inline doc block warning middleware authors about the collect-then-yield constraint and directing them to ADR 006.

### ✅ Issue #6 — `RuntimeMiddlewareContext.scope` is hard-coded to `"runtime"` — RESOLVED

**Symptom.** `idb-runtime.ts` set `scope: "runtime"` unconditionally. The vendor framework's cache middleware skips caching inside transactions (scope `"transaction"`) to preserve read-after-write coherence.

**Fix (Phase 6.3).** `IdbTransactionScope.execute()` bypasses the `RuntimeCore` middleware chain entirely — it calls `executeOpInTx` directly inside the pre-opened IDB transaction. Because middleware never fires during scope execution, the cache middleware cannot incorrectly cache reads made inside a `withMutationScope()` block. The `scope: "runtime"` in `buildMiddlewareContext` remains correct for non-scoped (top-level) executions.

### ✅ Issue #7 — `contract.json` and `contract.d.ts` index `unique` field is inconsistent — FIXED

`verifyIndex()` in `schema-verify.ts` now normalises both sides with `?? false` before comparing — the same pattern already used for `multiEntry`. `undefined` and `false` are treated as equivalent, so `byAuthorId` (which omits `unique` in `contract.json`) no longer triggers a mismatch.

### Issue #8 — Filter shorthand cannot express `null`-check, only equality

**Symptom.** `db.users.where({ deletedAt: null }).all()` matches no rows even when there are rows with `deletedAt === null`, because `#buildFilter()` does `row[key] !== value` — and when value is `null`, IDB serializes the field as `undefined` if absent, so the comparison is `undefined !== null` → true → filter excludes the row.

**Impact.** Today's contract has no nullable scalars on User/Post, so this is latent. Will bite immediately when nullable fields are introduced.

**Fix sketch.** Phase 6.1 plan covers this with `IdbNullCheckExpr` + `shorthandToFilterExpr` that converts `value === null` to a `null-check` expression.

### ✅ Issue #9 — `prisma-idb-usage` has no automated tests — FIXED

The demo app has been refactored into a thin query-runner shell (a textarea + JSON output panel, modeled on `apps/usage`) so Playwright specs drive the ORM directly through the assembled stack instead of clicking a hand-coded UI. The shell reads `?db=<name>` from the URL so each spec gets an isolated IDB database, and the helpers in `tests/helpers.ts` ship a `runner` fixture that resets the DB between tests.

Coverage (18 specs):

- `tests/smoke.spec.ts` — 6 specs covering Path A auto-migration plus every MVP `IdbStoreAccessor` terminal (`create`, `all`, `findUnique`, `delete`, `orderBy + take + skip`, `include` across a 1:N relation).
- `tests/operators.spec.ts` — 12 specs covering shorthand filtering with `null` and every Phase 6.1 operator (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `isNull`, `isNotNull`) plus all three combinators (`and`, `or`, `not`) including nested + chained compositions.

`playwright.config.ts` was switched from the `**/*.e2e.{ts,js}` shape to `testDir: "./tests"` so the standard `*.spec.ts` discovery works.

### ✅ Issue #10 — Module-level grouping key counter — FIXED

The `let _key = 0` counter now lives inside the `IdbStoreAccessorImpl` constructor as a closure variable, giving each root accessor its own counter. Builder-chain clones (`where()`, `take()`, `skip()`, etc.) receive the same `newGroupingKey` factory via `#clone()`, so all chained copies share one counter per root. Two separate `idbOrm()` clients no longer interleave keys.

### Open gaps (Phase 6.1–6.7)

- 6.1: Full operator API (`gt`, `lt`, `gte`, `lte`, `contains`, `startsWith`, `endsWith`, `in`, `notIn`, `not`, `AND`, `OR`, `isNull`) + Proxy-based `IdbModelAccessor`
- 6.2: `update`, `updateMany`, `upsert`, `createMany`, `deleteMany`, `count`
- 6.3: `IdbTransactionScope` + `withMutationScope()` in `client-idb`
- 6.4: Nested relation writes via `IdbRelationMutator`, `parseMutationInput`, `partitionByOwnership`, `createGraph`, `updateFirstGraph`
- 6.5: `include(rel, refineFn)` — refined child accessor state + `IdbIncludeScalar` for `count()`
- 6.6: Standalone `accessor.aggregate()` + `groupBy(field).aggregate(...)` via `IdbGroupedAccessor`
- 6.7: `select(...fields)` projection with FK augmentation for pending includes

### Recommended next steps

1. **Start Phase 6.1** (filter operators). Largest single quality-of-life jump; Mongo ORM has a clean pattern to port.
2. **Add at least one E2E spec** in `prisma-idb-usage` (Issue #9) so the assembled stack has regression coverage.
3. **Fix Issue #6** (scope hard-coding) when Phase 6.3 lands — the fix is gated on `IdbTransactionScope` existing.

---

## Second-round review (2026-05-25, vendor cross-check)

Audit comparing our six packages against the cloned vendor reference (`vendor/prisma-next/`), particularly mongo-target (`packages/3-mongo-target/`), sqlite-target (`packages/3-targets/3-targets/sqlite/`), and the sql/mongo families. What follows is just the gaps not already enumerated in the first-round review or in Phase 6.1-6.7.

### ✅ Issue #11 — `executeBatchPlan` opens readonly for update-only batches — FIXED

**Symptom.** [packages/prisma-orm/driver-idb/src/core/execute/index.ts:92](packages/prisma-orm/driver-idb/src/core/execute/index.ts#L92) determined the transaction mode by checking only for `"put"` and `"delete"` op kinds. A batch consisting only of `update` ops (or any future write op other than put/delete) would open the IDB transaction in `readonly` and the inner `store.put(merged)` would abort with `ReadOnlyError`.

**Why this was hidden.** The existing tests in [packages/prisma-orm/driver-idb/test/execute.test.ts](packages/prisma-orm/driver-idb/test/execute.test.ts) only exercised batches with put/delete; the `update`-only path was never tested.

**Fix.** The condition now also includes `"update"`. A regression test was added that runs a batch of one `update` op and verifies the merged row is written back. `planTxMode()` (used by atomic plans) already had this right; the divergence between `planTxMode` and `executeBatchPlan` was the underlying defect.

### ✅ Issue #12 — `autoMigrate` plans from `fromContract: null` and breaks contract evolution — FIXED

**Symptom.** [packages/prisma-orm/client-idb/src/core/auto-migrate.ts](packages/prisma-orm/client-idb/src/core/auto-migrate.ts) called `planner.plan({ fromContract: null, ... })` regardless of the live IDB state. For a fresh database this produces a correct "create everything" plan. But when the user changes their contract (e.g. adds a `Post` model to an existing v1 database with a `User` store), the planner emits ops to create `User` AND `Post` AND the marker store. The runner then opens at the next IDB version and tries to `createObjectStore("users")` inside `upgradeneeded` — which aborts the version-change transaction because the store already exists.

**Impact.** The auto-migration path was only correct for two scenarios: the first run (empty DB) and re-opens with identical contracts. Any contract evolution broke. The demo app worked only because the manifest's pre-baked `idbVersion: 1` matched the initial signed contract — once a user changed `contract.server.ts` they would have hit this immediately on next browser load.

**Fix.** Added `introspectLiveDb()` which opens the existing DB, reads `objectStoreNames`/`indexNames`/`keyPath`/`unique`/`multiEntry` via the IDB introspection API, and constructs a synthetic `fromContract` object whose `storage.stores` matches the live schema. The planner now produces a true delta plan (only the new ops). Three regression tests cover v1→v2 (add store), v2→v3 (add index), and v1→v1 (identity no-op).

**Note.** SSR-aware mode (when the caller passes a `manifest` loaded server-side) still derives `targetVersion` from `manifest.idbVersion`. Introspection is purely a planner input — the manifest path's `idbVersion` continues to govern the IDB version bump.

### ✅ Issue #13 — `idbRuntimeAdapterDescriptor.create()` used `emptyCodecLookup` — FIXED

**Symptom.** First-round Issue #3 fixed `createIdbClient()`'s direct `new IdbAdapter(idbCodecLookup)` instantiation, but the framework-facing descriptor in [packages/prisma-orm/adapter-idb/src/exports/runtime.ts](packages/prisma-orm/adapter-idb/src/exports/runtime.ts) still constructed the adapter with `emptyCodecLookup`. Any code path that goes through the descriptor's `.create(stack)` factory (the canonical way per the vendor pattern — see `vendor/prisma-next/packages/3-mongo-target/2-mongo-adapter/src/exports/runtime.ts`) would silently get an adapter with no codec resolution.

**Impact.** Latent today (all `idb/*` codecs are identity), but pre-Phase 6.x non-identity codecs (`DateTime` → `Date`, custom user codecs) would silently mis-route through the descriptor path.

**Fix.** The descriptor now imports `idbCodecLookup` from `@prisma-idb/target-idb/runtime` and passes it to `new IdbAdapter(...)`. The hand-constructed adapter in `createIdbClient` and the descriptor-built adapter now agree.

### ✅ Issue #14 — Migration TS renderer emits `unique: undefined` — FIXED

**Symptom.** [packages/prisma-orm/target-idb/src/core/migration-planner.ts:97](packages/prisma-orm/target-idb/src/core/migration-planner.ts#L97) rendered the `unique` field via `String(op.def.unique)`. When the contract canonicaliser stripped `unique: false` (default-stripping behaviour), `op.def.unique` was `undefined` and `String(undefined)` produced the literal string `"undefined"`. The emitted `migration.ts` then contained `createIndexOp("posts", "byAuthorId", { keyPath: "authorId", unique: undefined })` — invalid TypeScript under `exactOptionalPropertyTypes: true` and ambiguous at runtime.

**Visible in this repo.** [apps/prisma-orm-usage/migrations/app/20260525T1045_migration/migration.ts:8](apps/prisma-orm-usage/migrations/app/20260525T1045_migration/migration.ts#L8) was the example. The app's own tsconfig isn't strict on this so typecheck passed, but the file is shipping bad code.

**Fix.** The renderer now defaults missing `unique` to `false` before string-formatting, matching IDB's own default in `IDBObjectStore.createIndex`. A regression test covers the omitted-unique case.

### ✅ Issue #16 — `IdbMiddleware` used non-SPI field `family: "idb"` — FIXED

**Symptom.** [packages/prisma-orm/runtime-idb/src/idb-middleware.ts:25-27](packages/prisma-orm/runtime-idb/src/idb-middleware.ts#L25) declared `readonly family: "idb"`. The framework SPI (`RuntimeMiddleware` in `vendor/prisma-next/packages/1-framework/1-core/framework-components/src/execution/runtime-middleware.ts`) defines `familyId?: string` and the vendor families (`MongoMiddleware`, `SqlMiddleware`) narrow it to `familyId?: 'mongo'` / `familyId?: 'sql'`. Using a non-standard `family` field meant:

1. Cross-family middleware (e.g. `@prisma-next/middleware-cache`) that declared `familyId?: undefined` was not assignable to our middleware array.
2. The framework's `checkMiddlewareCompatibility()` helper, which reads `familyId`, would see our middleware as cross-family rather than IDB-specific.

**Fix.** Renamed to `familyId?: "idb"` matching the vendor pattern. The narrowing is optional so cross-family middleware drops in cleanly. All existing tests updated.

### ✅ Issue #15 — `diffIdbSchema` doesn't detect mutations to existing indexes — FIXED

**Symptom.** [packages/prisma-orm/target-idb/src/core/schema-diff.ts](packages/prisma-orm/target-idb/src/core/schema-diff.ts) only detected three kinds of index changes: new index added, index removed, store added with indexes. Changes to an _existing_ index (e.g. `unique: false → true`, `keyPath: "name" → "lastName"`, `multiEntry` toggling) produced an empty diff. The new contract's storageHash silently mismatched the marker and the user got mysterious schema drift forever.

**Fix.** `diffIdbSchema` now walks each surviving index pair and compares `keyPath` / `unique` / `multiEntry` (with `unique`/`multiEntry` defaulting to `false` for canonicaliser-stripped contracts). When any of those differ, it emits a `dropIndex` op followed by a `createIndex` op — IDB has no in-place alter for indexes. Six unit tests cover the new paths and one client-idb e2e test asserts that loosening a `unique:true` index lets two records share the same indexed value through the full auto-migration flow.

**Store-level mutations.** As a related correctness guard, the diff also throws if an existing store's `keyPath` or `autoIncrement` flag changes — IDB cannot alter those without dropping the store, and silent no-op is worse than an explicit error. The recovery path is an explicit manual migration that drops + recreates the store with whatever data-preservation strategy the caller wants.

### ✅ Notes on what's _not_ a bug

- **Codec descriptors placement on the target, not the adapter.** Mongo places `codecDescriptors` on the adapter descriptor (`vendor/prisma-next/packages/3-mongo-target/2-mongo-adapter/src/exports/runtime.ts`). Sqlite places them on the target (no codecs export from the SQL adapter). We chose the sqlite pattern (codecs on `target-idb`), which is correct for a target-only family. Either works structurally — the framework consumes from whichever descriptor exposes `types.codecTypes.codecDescriptors`.
- **`autoMigrate` always passing policy `ALLOW_ALL`.** First-round notes flagged this implicitly. ADR-008 Path A is "browser-side single-user" — there is no separate deploy review step. `ALLOW_ALL` is intentional. The CLI's `db update` (Path B) uses a tighter default policy.
- **Manifest writes happen in `executeAcrossSpaces`, not `execute`.** This looked weird relative to SQL/Mongo (which write the marker inside the same DB transaction as the DDL), but IDB cannot reach the manifest from inside the version-change transaction (the manifest is a Node-side file). The fake-IDB dry-run + manifest write pattern is the closest equivalent.

### Recommended next steps (updated 2026-05-26)

With Phase 6.2 and Issue #6 shipped, the queue is:

1. **Phase 6.4** — Nested relation writes (`create`/`connect`/`disconnect` inside `create`/`update`). Requires Phase 6.3 (now done). Port `parseMutationInput`, `partitionByOwnership`, `createGraph`, `updateFirstGraph`, `IdbRelationMutator` from sql-orm-client.
2. **Phase 6.5** — Include refinement (`include(rel, refineFn)`). Port refined child accessor state + `IdbIncludeScalar` for `count()`.
3. **Phase 6.6** — Aggregate / groupBy. `IdbGroupedAccessor`, `createAggregateBuilder`, standalone `accessor.aggregate()`.
4. **Phase 6.7** — Select projection. `selectedFields` in state, post-load field stripping, FK augmentation for includes.

---

## Historical: Original Phase 1-4 summaries

<details>
<summary>Phase 1-4 are done — click to expand for reference</summary>

### Phase 1 — Codec system (target-idb)

**Goal:** `target-idb` contributes a full `CodecLookup` for all 9 IDB scalar types.

**How it works:** The framework reads `types.codecTypes.codecInstances: ReadonlyArray<Codec>` off the descriptor at stack-assembly time and builds a `CodecLookup` internally.

**Implemented:**

- `src/core/codecs.ts` — one `Codec` object per scalar (9 total)
- Each codec: `id`, `targetTypes`, `traits`, `encode`, `decode`, `encodeJson`, `decodeJson`
- IDB stores JS values natively, so most are identity transforms
- Notable: `DateTime` → JS `Date`, `Decimal` → string round-trip, `Bytes` → `Uint8Array`/`ArrayBuffer`, `BigInt` → `bigint`

### Phase 2 — Runtime plane: driver (driver-idb)

**Goal:** `driver-idb/runtime` can open an actual `IDBDatabase` and execute basic operations.

- `create(dbName, version)` opens `window.indexedDB.open(...)`
- `execute(planBody)` runs a plan body inside an IDB transaction
- Tested with `fake-indexeddb`

### Phase 3 — Runtime plane: query lowering (adapter-idb)

**Goal:** `adapter-idb/runtime` translates a Prisma query AST into IDB plan bodies.

- Implemented `lower(queryAST)` for `findMany`, `create`, `update`, `delete`, `findFirst`, `findUnique`
- `IdbQueryAst` added for middleware introspection of query intent

### Phase 4 — Control plane: manifest-based operations (family-idb)

**Goal:** Manifest file operations for the CLI.

- Manifest file format (JSON, versioned)
- `introspect`, `verify`, `sign`, `readMarker`, `schemaVerify`

</details>

**Immediate next step** = Phase 6.1 (filter expression AST). Demo app scaffold (`apps/prisma-orm-usage/`) is being set up in parallel by the user. Tests follow the red-green pattern: write the test in the demo app first, then implement in the package.

Also consider WebWorker support (Phase 8) — the runtime and driver should be architected with workerization in mind (no direct `window` access in the driver, abstracted via an adapter layer).
