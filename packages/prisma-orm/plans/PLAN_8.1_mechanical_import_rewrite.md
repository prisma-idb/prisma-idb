# Phase 8.1 — Mechanical import/package rewrite

Status: **implemented, PR not yet opened**. This document records what
shipped, what's still red and why, and which later phase owns each
remaining failure. Read this alongside `PLAN_8.0_prisma8_port.md` (the
survey this phase executes against) — this doc doesn't re-derive anything
`PLAN_8.0` already established.

## 0. Pre-flight: version re-check (done, per "before you start" in PLAN_8.0)

Ran 2026-08-22, before any edits:

- `git -C vendor/prisma fetch --tags && pull origin main` — up to date.
  Newest non-dev tag is still `v8.0.0-rc.4`; no `v8.0.0-rc.5` tag exists.
- `npm view @prisma/{orm-framework,orm-toolchain,orm-postgres} dist-tags --json`
  — all three still report `{"latest": "8.0.0-rc.4"}`. No drift.
- `npm view prisma@next version` — `8.0.0-rc.7`, confirmed the separate CLI
  counter per PLAN_8.0's callout, not evidence of ORM drift.
- **Conclusion: the `8.0.0-rc.4` exact pin stands.** No re-survey needed.

Also verified, since PLAN_8.0's §1/§6 read ambiguously on one point:

- `npm view @prisma/{orm-framework,orm-toolchain,orm-postgres}@8.0.0-rc.4 exports --json`
  — read directly against the published exports maps (not `vendor/prisma`'s
  main branch, which is ahead of the rc.4 tag). **§6's mapping table is
  exactly correct**, including the `framework-components/X` →
  `orm-framework/components/X` double-segment. No corrections needed.
- `npm view @prisma/orm-toolchain@8.0.0-rc.4 peerDependencies` — confirmed
  `@prisma/cli-engine: "0.2.0"` is a **hard, non-optional peer** (absent
  from `peerDependenciesMeta`). This repo's `.npmrc` sets
  `strict-peer-dependencies=true`, so every package.json that adds
  `@prisma/orm-toolchain` needed `@prisma/cli-engine@0.2.0` pinned alongside
  it or `pnpm install` fails outright. Confirmed empirically: `pnpm install`
  succeeded cleanly with the peer pinned everywhere it was needed.

## 1. What shipped

- **Every Tier 1 package.json** (`{adapter,client,driver,family,runtime,
sync-extension,sync-server,target}-idb`, `sync-server-sql`) plus
  `apps/prisma-orm-usage` and `tests/prisma-idb-cli` (the latter two
  weren't named in PLAN_8.0's phase table but share the same import
  surface and needed the identical swap): `@prisma-next/*` dependency
  entries replaced with `@prisma/orm-framework` and/or
  `@prisma/orm-toolchain` (`@prisma/orm-postgres` for `sync-server-sql`
  only), each pinned to the exact `8.0.0-rc.4`. `@prisma/cli-engine@0.2.0`
  added as a devDependency wherever `orm-toolchain` was needed.
- **Every real import specifier** across `src/`, `test/`, and the two
  non-obvious spots PLAN_8.0 flagged as easy to miss:
  - `family-idb/src/core/contract-space-codegen.ts:144` — a
    `@prisma-next/migration-tools/spaces` import specifier embedded inside
    a codegen template string (emitted into generated contract-space
    files), not a normal static import. Rewritten.
  - `client-idb/test/_contract-space-fixture.ts` and
    `sync-extension-idb/test/_contract-space-fixture.ts` — real
    `migration-tools/hash` imports in test fixtures, absent from PLAN_8.0's
    §6 table (scoped there to `src/` only). Rewritten; their packages'
    `orm-toolchain` dependency was added as `devDependency` since the only
    consumer is test code.
  - `tests/prisma-idb-cli` — not mentioned in PLAN_8.0 at all. Its
    `test/_helpers.ts` imports `migration-tools/hash` directly. Rewritten,
    package.json updated the same way.
  - `sync-server-sql/prisma-next.config.ts` — rewrote the
    `@prisma-next/postgres/config` specifier only (not the file's
    `prisma-next.config.ts` → `prisma.config.ts` rename/envelope wrap —
    that's Phase 8.5's job per PLAN_8.0 §9).
- **Left untouched, deliberately:**
  - Everything under any `migrations/` directory (checked-in migration
    packages) — Phase 8.2 owns that tree; its layout migrator aborts on a
    `migrationHash` mismatch, so nothing there should move before 8.2 runs.
  - `sync-server-sql/test/fixtures/schema.generated.d.ts` and
    `sync-server-sql/test/fixtures/migrations-postgres/app/refs/db.contract.d.ts`
    — these import `@prisma-next/{adapter,target}-postgres` and
    `@prisma-next/sql-contract`, which are Tier-2 SQL-family-internal
    packages absent from §6's table entirely (per PLAN_8.0 §1/§2, we don't
    consume that layer). Confirmed by grep: our rewrite rules don't even
    match those specifiers.
  - Comment-only mentions of the old scope (e.g. `@prisma-next/sql-relational-core/ast`
    in doc comments describing an analogous SQL-family pattern) — cleanup,
    not the task.
- **One mechanical production fix beyond pure renaming**, because it was a
  hard compile error on a **production** call site with a fully-derivable
  correct value (not a design decision, not a placeholder):
  `family-idb/src/core/resolve-cli-paths.ts`'s `loadConfig` now returns
  `Result<LoadedConfig, CliStructuredError>` instead of the config
  directly (`LoadedConfig = { config: PrismaNextConfig, diagnostics }`).
  Unwrapped the `Result`, throwing on `!loaded.ok` using the real
  `CliStructuredError` (`extends Error`, so `.message` is the human-readable
  string — there is no `.summary` field despite the shape's resemblance to
  the _old_ CLI's plain JSON error envelope).
- **One more mechanical fix, same rationale**, discovered via a genuine
  compile error, not anticipated by PLAN_8.0 (see §2 below):
  `MigrationPlanWithAuthoringSurface.renderTypeScript` now takes a required
  `ImportSpecifierResolver` argument (unrelated to the migration
  snapshot-store layout — see §2). Fixed both real call sites
  (`family-idb/src/core/migration-plan.ts:318` in production,
  `target-idb/test/migration.test.ts`'s six call sites) by passing
  `keepInternalSpecifiers` — the framework's own documented no-op default,
  since we have no import-root remapping feature (ADR 242) to speak of.
  `target-idb`'s test suite went from 6 hard type errors to **0**, and its
  `pnpm test` went from failing to build at all to **82/84 passing** — the
  2 remaining failures are the already-documented `sha256:` prefix removal
  (§3 item 2 in PLAN_8.0), Phase 8.2's job, not a regression from this fix.

## 2. New findings — not in PLAN_8.0 §3, discovered via real tsc errors against the installed rc.4 `.d.mts`, not guessed

Four breaks, each confirmed against the actual installed package (not
assumed from changelog prose):

1. **`MigrationPlanWithAuthoringSurface.renderTypeScript` takes a required
   `ImportSpecifierResolver`** (`(specifier: string) => string`), not the
   `MigrationScaffoldContext` its neighbor `emptyMigration` takes — these
   are two different, easily-confused parameters (I initially mixed them
   up; corrected after reading `@prisma/orm-framework`'s
   `control-BE92GNIR.d.mts` directly). Purpose: ADR 242's import-root
   rewriting, so a scaffolded `migration.ts` resolves correctly under
   whatever import root the consuming app installed. We have no such
   remapping feature, so `keepInternalSpecifiers` (the framework's own
   documented "keep names as-is" export) is the correct value, not a
   placeholder. **Fixed in this phase** — see §1.
2. **`scalarTypeDescriptors` removed entirely from `AdapterDescriptor`**
   (`adapter-idb/src/core/descriptor-meta.ts:21`) — not renamed, deleted.
   Traced to `vendor/prisma` commit `72cd71550f` ("TML-2986: unify PSL
   scalar types and add native scalar constructors #1022`, 2026-07-23):
*"Models every scalar as a zero-argument type constructor and removes
the separate scalar-descriptor registry... target adapters retain
ownership of target-specific storage mappings."* Confirmed
`target-idb/src/core/codecs.ts`'s `codecDescriptors`/`idbCodecLookup`
do **not** already carry the PSL-scalar-name (`"String"`, `"Int"`, …) →
codec-id mapping the old `scalarTypeDescriptors`Map held — they're
keyed by`codecId`and`targetTypes`(runtime JS types), a different
axis. Checked`@prisma/orm-postgres`'s `/target/codec-ids`and`/target/codec-descriptor`subpaths as the reference target
implementation per the advisor's suggestion — both are pure re-exports
of a private`@prisma/orm-target-postgres`package not present in`node_modules`, so the actual registration pattern couldn't be read
from the installed tree. **Not fixed — genuinely open.** Whoever picks
this up needs to find where the "unified authoring channel" (the
`Authoring*`family of types already visible in`@prisma/orm-framework/components`'s export list —
`AuthoringTypeConstructorDescriptor`, `instantiateAuthoringTypeConstructor`,
etc.) expects a target to register its scalar-name-to-codec mapping now,
most likely by cloning `vendor/prisma`'s Postgres target source (not
just its npm dist) and reading how it authors its native scalar
constructors post-#1022. This blocks `adapter-idb`'s typecheck.
3. **`scalarTypes` removed from `BuildSymbolTableOptions`**
   (`family-idb/src/core/psl-provider.ts:130`, plus two test fixtures) —
   almost certainly the same #1022 unification (PSL scalar authoring moved
   off a flat list), not independently investigated in depth given time
   budget. Record as likely-same-root-cause as finding 2, not confirmed
   identical. **Not fixed.**
4. **`loadConfig` return shape changed** (`config-loader`) — covered in §1,
   fixed.

## 3. Phase-ordering correction to PLAN_8.0 §8.2/§9

**`prisma-next@0.16.0` (the old unified CLI, still a devDependency in
`sync-extension-idb` and `sync-server-sql` for their `contract:emit`/
`db:init`/`migration:plan` scripts) is confirmed dead against rc.4
packages, not just "expected friction."** Ran
`sync-server-sql`'s `pnpm check` (which shells out to `prisma-next contract
emit --config prisma-next.config.ts` before `tsc`) and got:

```json
{
  "ok": false,
  "code": "PN-CLI-4009",
  "domain": "CLI",
  "severity": "error",
  "summary": "Config validation error",
  "why": "Config.extensions is not supported; use Config.extensionPacks",
  ...
}
```

The 0.16.0 CLI binary rejects the rc.4-shaped config (`extensions`, not
`extensionPacks`) our `prisma-next.config.ts` now produces via
`@prisma/orm-postgres/config`'s `defineConfig`. This isn't a config-content
bug — the CLI and the config-producing packages have simply diverged past
the point of compatibility. Separately, `tests/prisma-idb-cli` (23/32
failing) confirmed the same root family of problem from the other
direction: rc.4's `config-loader` only recognizes `prisma.config.ts`,
never `prisma-next.config.ts` (confirmed via `grep -rn "prisma.config.ts"`
across the installed `@prisma/orm-toolchain` dist — `prisma-next.config.ts`
does not appear anywhere in its file-discovery code).

**This means PLAN_8.0's §9 phase table and §8.2 stack diagram have the
wrong order.** §9 says Phase 8.3 ("re-emit every contract") depends only on
8.1. But re-emitting a contract requires a working `contract emit`, and the
only CLI capable of that against rc.4-shaped config is the one **Phase 8.5
(config unification) and 8.6 (CLI mounting) build** — not the one we have
today. **8.5 (at minimum the `prisma-next.config.ts` → `prisma.config.ts`
rename + envelope) must land before 8.3's "re-emit every contract" step is
possible**, not after it as currently drawn.

The advisor's suggested cheap-unblock check — swapping the
`prisma-next@^0.16.0` devDependency for a pinned `prisma@8.0.0-rc.7`
(which depends on `@prisma/orm-toolchain: 8.0.0-rc.4` exactly, matching our
pin) plus the config rename — was **not attempted in this phase**; it's
recorded here as the concrete next step for whoever scopes the
reordered 8.5.

## 4. Full validation results for this phase

Ran across all of Tier 1 plus `apps/prisma-orm-usage` and
`tests/prisma-idb-cli`:

- **`pnpm build`** (all 9 Tier 1 packages): **green.** tsdown/rolldown
  builds don't strip types the way `tsc --noEmit` does, so this confirms
  wiring/bundling, not full type-safety — see `pnpm check` below for that.
- **`pnpm lint`** (prettier + eslint, all touched packages): **green**
  after `pnpm format` (the perl-based mechanical rewrite and manual
  multi-line edits weren't prettier-formatted as they were made; one
  `pnpm format` pass across the touched packages fixed every file, only
  `dist/` build-output formatting differences beyond that, which don't
  matter — `dist/` is gitignored).
- **`pnpm check`** (`tsc --noEmit`, all 9 Tier 1 packages): **4 of 9 red**
  — every failure traced to a specific, named, later phase or an
  unresolved finding above, none to an incomplete import rewrite:
  - `adapter-idb` — finding 2 above (`scalarTypeDescriptors`), unresolved.
  - `family-idb` — 6 errors: 3× `extensionPacks`→`extensions` (§3 item 3,
    **Phase 8.3**), 3× finding 3 above (`scalarTypes`), unresolved.
  - `runtime-idb` — 3 errors, all `RuntimeCore.runExecute` abstract member
    / `execute()` signature conflict — **exactly** PLAN_8.0 §4's "one real
    engineering problem," **Phase 8.4**, budgeted there as its own
    review-and-test pass. Not attempted here.
  - `sync-server-sql` — its `check` script's `contract:emit:postgres`
    pre-step fails against the dead 0.16.0 CLI — §3 above, **Phase
    8.5/8.6** (reordered ahead of 8.3).
  - `adapter-idb`/`driver-idb`/`client-idb`/`sync-server`/`target-idb`/
    `sync-extension-idb` individually type-check clean when run in
    isolation with `--continue` (the first `pnpm check` run without
    `--continue` showed them as "failed" too, but that was turbo aborting
    sibling tasks mid-run when `family-idb` failed, not real errors —
    confirmed by re-running with `--continue`).
- **`pnpm test:prisma-next`** (vitest, `--continue`): 7 of 10 packages
  failed, all attributable to the same four causes above surfacing at
  runtime instead of compile time:
  - `client-idb`, `family-idb`, `sync-extension-idb` — `TypeError:
this.runExecute is not a function` at runtime (the RuntimeCore split,
    Phase 8.4 — same root cause as the `runtime-idb` typecheck failure,
    now visible transitively in every package that constructs an
    `IdbRuntimeImpl` and calls `.execute()`).
  - `target-idb` — 82/84 passing; the 2 failures are the documented
    `sha256:` prefix removal (§3 item 2, Phase 8.2). The inline-snapshot
    test (`renderTypeScript() round-trips unique/multiEntry/indexes
exactly`) **passing byte-for-byte** is real evidence
    `keepInternalSpecifiers` renders output identical to before the
    `ImportSpecifierResolver` fix — worth citing in review so nobody
    re-derives it.
  - `sync-server-sql` — same dead-CLI cause as its `check` failure.
  - `cli-tests` — 23/32 failing, all "Config file not found" (the
    `prisma.config.ts` rename, Phase 8.5, confirmed by grep above — not a
    new problem).
  - `adapter-idb`, `driver-idb`, `sync-server` — passing.

**None of the red above is new scope invented by this phase** — every
failure resolves to a phase PLAN_8.0 already named (8.2, 8.3, 8.4, 8.5/8.6)
or one of the two unresolved findings in §2, both flagged for the phase
that will need to touch that code next (most likely folded into 8.3, since
both are contract/PSL-authoring shape changes, but not committed to that
without further scoping).

## 5. What a fresh session picking up 8.2/8.3/8.4/8.5 needs to know

- Don't re-run the version-drift re-check — §0 above is current as of
  2026-08-22.
- Don't re-derive §6's mapping table — verified correct against the
  published exports maps, cited in §0.
- Read §3 above before assuming 8.3 can start right after 8.1 merges —
  it can't, until 8.5 (or at least a working `contract emit`) exists.
- The two open findings in §2 (`scalarTypeDescriptors`, `scalarTypes`)
  need their own investigation before whichever phase claims them can
  start — don't assume "delete the field" is correct without confirming
  where (or whether) the PSL-scalar → codec mapping now lives.
