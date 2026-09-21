# Phase 8 — Port to Prisma 8 RC

[`PLAN_8.0_prisma8_port.md`](PLAN_8.0_prisma8_port.md) is a source-grounded
survey (not yet implementation) of moving from the frozen `@prisma-next/*`
0.16.0 scope to `@prisma/*` `8.0.0-rc.4`. Read it before starting any work
against `vendor/prisma` past this point — it resolves the "does our
dependency surface even still exist" gate, maps every import we make to its
new home, flags the one real engineering problem (the `RuntimeCore`
query()/execute() split hitting `runtime-idb`'s `IdbRuntimeImpl` subclass),
and scopes mounting our CLI commands into `@prisma/cli-engine`'s public
primitives instead of keeping a bespoke standalone bin. **Read its "Before
you start" callout first** — a version-drift check (npm's `prisma@next` is
already three RCs ahead of the git tag this survey targeted) needs
re-verifying before Phase 8.1 locks an exact version pin. Implementation
lands as a stack of PRs (§8 of that doc) — each phase gets its own
`PLAN_8.x_*.md` once it starts, following this README's existing Phase 7
convention.

| Phase                                          | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Depends on |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [8.1](PLAN_8.1_mechanical_import_rewrite.md)   | Mechanical `@prisma-next/*` → `@prisma/*` import/package rewrite across Tier 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —          |
| [8.2](PLAN_8.2_content_hash_migration_tree.md) | Content-hash migration-tree conversion: strip `sha256:` prefix across the 3 Tier-1 migration roots (store-layout conversion found not to apply — see its §0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 8.1        |
| [8.3](PLAN_8.3_contract_layer.md)              | Contract-layer breaks, source-level only: `extensionPacks`→`extensions` + stale error-code sweep (contract re-emit deferred to 8.5 — see its §0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 8.1        |
| [8.4](PLAN_8.4_runtime_core_split.md)          | `RuntimeCore` query()/execute() split: `IdbRuntime`/`IdbQueryExecutor` renamed `execute`→`query`+`execute` (stats), `runExecute()` implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 8.1        |
| [8.5](PLAN_8.5_cli_config_unification.md)      | `sync-server-sql` only, narrowed from all Tier 1 — `prisma-next.config.ts`→`prisma.config.ts` + envelope + real `prisma` CLI wiring; re-emission everywhere else deferred to 8.6 (committed migration chains would go hash-inconsistent — see its §0)                                                                                                                                                                                                                                                                                                                                                                                  | 8.1, 8.3   |
| [8.6](PLAN_8.6_cli_mounting.md)                | `@prisma/cli-engine` shell (`idbCommandFamily`) for the 3 IDB-specific commands with no generic equivalent (`migration plan`/`contract-space`/`preflight`); rc.5 version bump across Tier 1; `cli-tests` rewritten (31/31, up from 9/31)                                                                                                                                                                                                                                                                                                                                                                                               | 8.1, 8.5   |
| [8.6.1](PLAN_8.6.1_chain_regen.md)             | Chain regeneration + `prisma.config.ts` rename for the 3 packages 8.6 deferred (`apps/prisma-orm-usage`, `sync-extension-idb`, kanban's IDB side) — wiped and re-baselined rather than bridged (user's call, mid-phase); found + fixed a real `auto-migrate.ts` marker-advancement bug and a pre-existing invalid IDB index along the way; kanban's `pnpm check` initially left red with a `contract.d.ts` typing defect, later root-caused (missing direct `@prisma/orm-framework` dependency, not a vendor bug) and fixed                                                                                                            | 8.6        |
| [8.7](PLAN_8.7_full_validation.md)             | Full validation pass — closed out PLAN_8.1's two open PSL-scalar-unification findings (`scalarTypeDescriptors`/`scalarTypes`, both vestigial post-#1022, confirmed by deletion + full test suite green — no vendor archaeology needed after all), fixed a `client-idb` straggler from 8.6.1, fixed a local-only `pnpm lint` false-positive (per-package prettier can't see the root `.prettierignore`). Stack is fully green apart from kanban's out-of-scope Tier 2 Postgres side (explicit carve-out, tracked under 8.8)                                                                                                             | 8.1–8.6.1  |
| [8.8](PLAN_8.8_postgres_port.md)               | Tier 2 (`apps/prisma-idb-kanban-example`'s Postgres side) — landed as one phase rather than a survey-then-decompose split (user's call). Grep-verified the real breaking-change surface was narrower than the full SQL-family CHANGELOG suggested; wiped + regenerated the migration chain via the real CLI against a live Postgres rather than hand-port two undocumented API reshapes found only in installed `.d.ts` files; validated end to end with the real Playwright suite (12/12) against a real database. Stacked on `phase-8.7-full-validation`, deviating from `PLAN_8.0` §8.2's original "not part of this stack" framing | 8.1–8.7    |
| [8.9](PLAN_8.9_contract_snapshot_store.md)     | Content-addressed contract-snapshot store adoption (ADR 240) — landed once Phase 8.8 made the IDB side the only migration layout still on the pre-ADR-240 sibling-copy shape. Grep-verified touch surface was just `migration-plan.ts` (writer+reader) + 2 tests, since IDB's `migration.ts` never imports the contract at all; rewrote it to write/read `migrations/snapshots/<hash>/`, regenerated all 3 committed IDB chains, confirmed `storageHash`/`ops.json` byte-identical to the pre-wipe chain                                                                                                                               | 8.1–8.8    |
| 8.10 (deferred)                                | PSL scalar-authoring unification (#1022) — **closed by 8.7**, see above; entry kept for history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 8.1        |

# Phase 7 — Migration package layer (Group A rewrite)

These working-doc plans implement the architectural feedback from
[`packages/prisma-orm/FEEDBACKS.md`](../FEEDBACKS.md). Each phase is a
self-contained chunk of the rewrite; the dependency chain is strict and the
intended landing order is the file order below.

| Phase                                    | Goal                                                                                                          | Depends on |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| [7.1](PLAN_7.1_foundation.md)            | `IdbMigration` base class, `MigrationCLI` shim, drop manifest layer                                           | —          |
| [7.2](PLAN_7.2_planner_refit.md)         | Planner emits class-based `migration.ts` with `MigrationCLI.run(...)` shim                                    | 7.1        |
| [7.3](PLAN_7.3_runner_refit.md)          | Runner: `executeAcrossSpaces` refuses; drop dry-run; space-keyed marker                                       | 7.1        |
| [7.4](PLAN_7.4_browser_runtime_refit.md) | `createAutoMigratingIdbClient` walks `contractSpace.migrations`; safe policy default; `versionchange` handler | 7.1, 7.3   |
| [7.5](PLAN_7.5_contractspace_codegen.md) | New CLI `prisma-next-idb generate-contract-space` writes the generated wiring module                          | 7.1        |
| [7.6](PLAN_7.6_preflight.md)             | New CLI `prisma-next-idb preflight` walks the chain against `fake-indexeddb`                                  | 7.1, 7.3   |
| [7.7](PLAN_7.7_app_migration.md)         | Migrate `apps/prisma-orm-usage` to new design; delete manifest; verify Playwright                             | 7.1–7.5    |
| [7.8](PLAN_7.8_cleanups_closure.md)      | Cross-cutting closure checklist (Group B items absorbed into 7.1–7.7)                                         | All above  |

## Landing strategy

Two PRs (current draft PR keeps the migration coherent, split if review surface gets unwieldy):

- **Stack 1 (foundation, planner, runner, browser)**: 7.1 → 7.2 → 7.3 → 7.4
- **Stack 2 (tooling, app, closure)**: 7.5 → 7.6 → 7.7 → 7.8

Each PLAN\_\*.md has its own acceptance criteria + test plan. None will be
committed verbatim — they are working docs for the implementation pass.

## Coupling notes

- 7.2 and 7.3 both consume types introduced in 7.1 (`IdbMigration`,
  `MigrationCLI`, dropped manifest). They are _independent_ of each other
  but both block 7.4.
- 7.4 is the first phase that touches user-facing browser API
  (`createAutoMigratingIdbClient`).
- 7.5 + 7.6 ship a new CLI binary under `family-idb` (or its own
  package — see 7.5 for the decision point).
- 7.7 is the only phase that actually breaks/fixes the demo app.
- 7.8 is a closure doc — most of its items are folded into the earlier
  phases; it exists to track what got absorbed vs. deferred.

## Vendor reference index

For each phase, the most directly relevant vendor reference:

| Phase | Vendor reference                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1   | `vendor/prisma-next/packages/3-targets/3-targets/postgres/src/core/migrations/postgres-migration.ts` (Migration subclass)            |
| 7.1   | `vendor/prisma-next/packages/1-framework/3-tooling/cli/src/migration-cli.ts` (CLI shim)                                              |
| 7.2   | `vendor/prisma-next/packages/3-targets/3-targets/postgres/src/core/migrations/render-typescript.ts`                                  |
| 7.3   | `vendor/prisma-next/packages/2-sql/9-family/src/core/migrations/runner.ts` (SQL runner shape for executeAcrossSpaces)                |
| 7.4   | `vendor/prisma-next/packages/3-extensions/postgis/src/exports/control.ts` (ContractSpace consumption)                                |
| 7.5   | `vendor/prisma-next/packages/3-extensions/postgis/migrations/refs/head.json` (head ref format)                                       |
| 7.5   | `vendor/prisma-next/packages/1-framework/3-tooling/migration/src/contract-space-from-json.ts` (helper signature)                     |
| 7.6   | `vendor/prisma-next/packages/1-framework/3-tooling/cli/src/commands/migration-check/` (chain validation pattern)                     |
| 7.7   | `vendor/prisma-next/packages/3-extensions/postgis/migrations/20260601T0000_install_postgis_extension/` (full package on-disk layout) |
