# Phase 8.8 — Tier 2 Postgres port (kanban's SQL side)

Stack layer: `feat/prisma-8` → ... → `phase-8.7-full-validation` →
`phase-8.8-postgres-port`. Depends on 8.1–8.7 in practice (not just in
principle): `apps/prisma-idb-kanban-example`'s `package.json` already
carries `@prisma/orm-framework`/`@prisma/orm-toolchain@8.0.0-rc.5` from the
IDB-side fix landed in 8.6.1, mixed with the full SQL family still pinned
to `@prisma-next/*@^0.16.0`. That mixed state exists only on this open
stack, not on `main` — so despite PLAN_8.0 §8.2 calling 8.8 "not part of
this stack," it's stacked here anyway (user's call). This deviates from
that doc; PLAN_8.0's own phase table and README are updated to say so
rather than leave a contradiction on record.

**Scope confirmed with the user up front**, three questions:

1. This PR ports kanban's entire Postgres side in one phase — not a
   survey-then-decompose split like Tier 1 got across 8.1–8.7. One
   sub-issue, one stacked PR, done fully.
2. Stack on `phase-8.7-full-validation`'s tip (not `main`) — see the
   dependency note above.
3. Full PLAN_8.0-equivalent survey rigor before writing any code: grep the
   actual import/construction surface, don't assume the CHANGELOG's
   SQL-family items apply just because they're in scope for the family in
   general.

## 1. What kanban's Postgres side actually touches (grep-verified)

Contrary to PLAN_8.0 §2's framing ("every SQL-specific breaking change...
does apply here"), the app's own code only touches a narrow slice. Files
importing anything from the old SQL-family scope:

- `package.json` — the dependency list itself (§4).
- `prisma-next.config.postgres.ts` — `defineConfig` from
  `@prisma-next/postgres/config`.
- `src/lib/server/db.ts` — default-export runtime client factory from
  `@prisma-next/postgres/runtime`, typed against the generated `Contract`.
- `src/lib/server/auth.ts` — **does not** touch prisma-next at all; its
  `pg.Pool` is a separate, direct `pg` connection for better-auth's own
  adapter, unrelated to this port.
- `migrations-postgres/app/{20260809T0831_baseline,20260809T1112_auth}/migration.ts`
  — hand-authored (well, CLI-scaffolded at authoring time) DDL migrations
  using `col`, `fn`, `lit`, `primaryKey`, `unique`, `Migration`,
  `MigrationCLI` from `@prisma-next/postgres/migration`, plus
  `this.createTable`/`addColumn`/`dropColumn`/`setNotNull`/`addForeignKey`/
  `createIndex`/`addCheckConstraint` instance methods.
- `src/lib/server/sync.ts` — imports the generated `Contract` type only
  (`ServerContract`), not any SQL-family package directly.

No aggregate/`groupBy` usage, no `.raw` lane usage, no RLS, no native
Postgres array/list columns, no hand-installed out-of-band CHECK
constraints. This cuts out most of the CHANGELOG surface PLAN_8.0 §2
flagged as unscoped risk (aggregate-registry construction, the raw-lane
facade reshape, RLS wire-naming) — verified by grep, not assumed, same
standard §6 held Tier 1 to.

## 2. Exports-map: old scope → rc.5 home

Confirmed against real installed tarballs
(`node_modules/.pnpm/@prisma+orm-postgres@8.0.0-rc.5.../`), not just the
CHANGELOG. The SQL family split into **three** public packages, not the
one `@prisma/orm-postgres` aggregate PLAN_8.0 §1 predicted:

| Old (`^0.16.0`)                                                                                           | rc.5 home                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@prisma-next/postgres`                                                                                   | `@prisma/orm-postgres` (aggregate — config/runtime/etc re-exported)                                                        |
| `@prisma-next/{sql-builder,sql-contract,sql-contract-psl,sql-orm-client,sql-relational-core,sql-runtime}` | `@prisma/orm-family-sql` (generic SQL family, family-agnostic surface)                                                     |
| `@prisma-next/{target-postgres,adapter-postgres,driver-postgres,family-sql}`                              | `@prisma/orm-target-postgres` (Postgres-target-specific: migration DSL, RLS policy rendering, control adapter)             |
| `@prisma-next/migration-tools`, `@prisma-next/contract`                                                   | `@prisma/orm-toolchain/migration-tools`, `@prisma/orm-framework/contract` — same as Tier 1's §1 table, framework-generic   |
| `@prisma-next/sql-contract-emitter`                                                                       | folded into `@prisma/orm-toolchain`'s emit pipeline — no direct import needed once the app moves to `prisma contract emit` |
| `prisma-next` (CLI binary, config loader)                                                                 | `prisma` (already a devDependency here at rc.7), reads `prisma.config.ts` in the cli-engine envelope shape                 |

App code only ever imports from the aggregate (`@prisma/orm-postgres/{config,runtime,migration}`) — never needs to reach into `orm-family-sql`/`orm-target-postgres` directly, confirmed by reading `orm-postgres`'s own `migration.d.mts` (`export * from "@prisma/orm-target-postgres/target/migration"`) and `runtime.d.mts`. Keeping the app on the aggregate import path (matching its current `@prisma-next/postgres/*` pattern) is the lower-churn choice and was verified to actually re-export everything the app needs.

## 3. Real breaking changes, filtered to what applies here

Read all 6 hops' upgrade-recipe docs (`0.16-to-0.17` through
`8.0.0-rc.4-to-8.0.0-rc.5`), filtered to constructs kanban's migrations
actually use:

1. **Config envelope + CLI rename** (rc.3→rc.4, `prisma-config-hard-cut-and-top-level-commands`) — same shape as Tier 1's 8.5/8.6.1: `defineConfig` moves inside `definePrismaConfig({ orm: ... })` from `@prisma/cli-engine`. `prisma-next.config.postgres.ts` → `prisma.config.postgres.ts`. The `prisma-next` CLI binary is gone; the real installed `prisma@rc.7` binary already exposes `contract`, `db`, `migration`, `migrate` as top-level command groups (confirmed via `pnpm exec prisma --help` — `migration new`/`migration plan`/`db init` all exist generically, unlike IDB which needed 8.6's bespoke `idbCommandFamily` because it has no first-party SQL/Mongo-style support).

2. **CHECK constraint IR reshape** (rc.1→rc.2, two linked entries): `CheckConstraint`/`SqlCheckConstraintIR` go from `{name, column, valueSet}` to `{name, prefix?, expression}`. The migration-class method signature changes from `{schema, table, constraint, column, values}` to `{schema, table, constraint, expression}` — confirmed against the real installed `.d.ts` (`postgres-migration-*.d.mts`). Kanban's one usage (`changelog_operation_check` on `changelog.operation`) needs its `column`/`values` replaced with a raw SQL `expression` string, or built via the new `checkExpression(name, expression)` helper exported from `@prisma/orm-target-postgres`'s migration surface.

3. **Every DDL migration method is now async** — **not documented in any of the 6 upgrade-recipe files**, found only by reading the real installed `.d.ts` directly (`postgres-migration-BNsrwlxh-BNsrwlxh.d.mts`): `createTable`, `addColumn`, `addForeignKey`, `createIndex`, `addCheckConstraint`, `setNotNull`, etc. all now return `Promise<SqlMigrationPlanOperation<...>>` (previously synchronous). Every call site in both migration files needs `await`, and `get operations()` most likely needs to become `async get operations()` or equivalent — the exact new authoring shape needs to be read off a **freshly CLI-scaffolded** migration file, not guessed from the type signatures alone.

4. **`foreignKey` becomes an importable constraint-builder function** (undocumented in the changelog, found the same way as #3): old code passed a bare object literal to `this.addForeignKey({schema, table, foreignKey: {name, columns, references, onDelete}})`; the new `foreignKey(columns, refTable, refColumns, {name?, onDelete?, onUpdate?})` helper exists alongside `primaryKey`/`unique`, suggesting the authoring style shifted toward composing constraint helpers rather than inline object literals — again, confirm the real shape from a scaffolded file rather than the type signature alone.

5. **Aggregate-registry construction** (0.17→rc.1, rc.1→rc.2) — **does not apply**: kanban defines no custom aggregates and calls none (`groupBy`/`aggregate` unused). The target's built-in standard aggregates (count/sum/avg/etc.) are provided by `@prisma/orm-target-postgres` itself; nothing in kanban's own code constructs an `aggregateDescriptors` registry by hand.

6. **Raw-lane facade reshape** (rc.3→rc.4, `facades-compose-the-raw-lane`) — **does not apply**: no `.raw` usage anywhere in kanban's source.

7. **RLS wire-naming, native Postgres type authoring, `pg/*` codec JSON-form changes** — **does not apply**: no RLS policies, no custom native-type authoring, no direct `pg/*` codec construction in app code (codec handling is entirely internal to the generated contract + runtime client).

8. **Contract re-emission consequences** (rc.1→rc.2, `re-emit-extension-contract-spaces`): re-emitting will add a wire-named CHECK for the one enum-shaped check kanban already has explicitly authored (`changelog.operation`), and (per the same note) would add element-non-null CHECKs for any `many` scalar-list column — kanban has none, so this is a non-event here, but worth having verified rather than assumed given it's exactly the kind of thing that silently produces a destructive migration plan later if missed.

9. **rc.4→rc.5 `suppressIdleConnectionErrors`** — the driver wraps pool/client bindings itself since rc.5 per the note; kanban's `db.ts` passes a connection-string URL (`db: { connection: process.env.DATABASE_URL }`), not a raw `pg.Pool`/`Client` binding, so the driver's own wrapping covers it with no app-code change needed. `auth.ts`'s separate raw `pg.Pool` for better-auth is untouched by this port (pre-existing, unrelated to prisma-next).

## 4. Decision: re-baseline via the real CLI, not hand-port the DSL

Given finding #3 and #4 above — two real, undocumented API reshapes only
visible by reading installed `.d.ts` files, not by reading the CHANGELOG —
hand-translating the two committed migration.ts files call-by-call is a
real correctness risk: the exact new authoring shape (is `operations` now
`async`? does it return `Promise<Op[]>` or resolve internally?) can't be
fully confirmed from type signatures alone, only from actually running the
target's own scaffolder.

Same call as 8.6.1 for the IDB side: **wipe `migrations-postgres/app/*`
entirely and generate one fresh baseline migration via the real, live CLI
against a running Postgres**, rather than bridge the two hand-translated
migrations forward. Justification is identical to 8.6.1's: this is a demo
app's dev/CI-only database (`docker-compose.yml`'s Postgres container,
recreated per `db:up`/CI run), nothing depends on the existing migration
hashes surviving, and the two existing migrations' entire history
(`baseline` + `auth`) collapses cleanly into one schema snapshot anyway.

This also sidesteps needing to hand-verify the CHECK-constraint and
`foreignKey`-helper reshapes (findings #2 and #4) — the CLI's own planner
generates correct calls against the real, current API by construction,
the same way `prisma-next-idb migration plan` already does for the IDB
side.

## 5. Implementation

1. `package.json`: drop `@prisma-next/{adapter-postgres,driver-postgres,family-sql,migration-tools,postgres,sql-builder,sql-contract,sql-contract-psl,sql-orm-client,sql-relational-core,sql-runtime,target-postgres}@^0.16.0` and `@prisma-next/{contract,sql-contract-emitter}@^0.16.0` and `prisma-next@^0.16.0`; add `@prisma/orm-postgres@8.0.0-rc.5` as a real dependency (already present as `sync-server-sql`'s devDependency elsewhere in the workspace, so no fresh version-drift check needed — rc.5 is confirmed current for this package too). Keep `prisma@8.0.0-rc.7` / `@prisma/cli-engine@0.2.0`, already present as devDependencies.
2. `prisma-next.config.postgres.ts` → `prisma.config.postgres.ts`: wrap in `definePrismaConfig({ orm: ormConfig({...}) })` per the rc.3→rc.4 envelope shape, keep `dotenv/config` as the first import.
3. `src/lib/server/db.ts`: `@prisma-next/postgres/runtime` → `@prisma/orm-postgres/runtime`, same default-export call shape (confirmed unchanged: `postgres<Contract>({ contractJson })`).
4. Wipe `migrations-postgres/app/{20260809T0831_baseline,20260809T1112_auth}/`. Update `package.json`'s `migration:postgres:new`/`status` scripts and `db:init`/`db:update` from `prisma-next <cmd> --config prisma-next.config.postgres.ts` to `prisma <cmd> --config prisma.config.postgres.ts` (verify exact subcommand names empirically against the installed CLI's `--help`, not assumed from the changelog's `prisma-cli` binary name — this repo's real installed binary is `prisma`, matching Tier 1's already-established finding that the changelog's `@prisma/cli`/`prisma-cli` naming is stale relative to the actual npm package).
5. Bring up `docker-compose.yml`'s Postgres (port 5433, isolated from the devcontainer's own 5432), run `prisma contract emit` against the updated config, then scaffold + apply one fresh baseline migration via the real CLI's `migration new`/`migrate` flow, reading the CLI-generated `migration.ts` to learn the real (now-confirmed, not guessed) authoring shape for the async DDL methods and the `foreignKey`/`checkExpression` helpers.
6. Re-run `writeSqlSchemaWithSync` (unchanged, framework-generic, Tier 1 code) to confirm it still produces a schema the new parser accepts — no changes expected here, but verify rather than assume.
7. `src/lib/server/sync.ts`: re-check `ServerContract` typing once the contract is re-emitted — expect the same `extensions`-missing gap 8.6.1 found on the IDB side to disappear the same way (framework-level `Contract` type now includes it).
8. Update `.github/workflows/build.yml`'s kanban Postgres e2e job if its `contract:emit:postgres`/`db:init` invocations changed shape.
9. Full validation against the real, live Postgres container (not just typecheck): `pnpm check` (kanban only, then repo-wide), `pnpm lint`, the existing `pnpm test:prisma-next-kanban-e2e` Playwright suite (login, CRUD, cross-device sync — already exercises the Postgres path end-to-end per PLAN_8.7 §5), and a manual `db:init` + `migrate` dry run against a freshly recreated container to confirm the baseline actually applies cleanly, not just that it typechecks.

## 6. What this does not do

- Does not touch Tier 1 or the IDB side of kanban — both already green
  per PLAN_8.7.
- Does not add RLS, native-type authoring, or aggregate customization —
  none of that exists in kanban today, so none of it is being ported;
  this phase is scoped to the surface kanban actually uses, not the whole
  SQL-family CHANGELOG.
- Does not change `better-auth`'s own `pg.Pool` usage in `auth.ts` — out
  of scope, unrelated to prisma-next.
