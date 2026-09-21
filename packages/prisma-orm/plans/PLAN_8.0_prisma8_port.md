# Phase 8 — Port from `@prisma-next/*` (0.16.0) to `@prisma/*` (Prisma 8 RC)

Status: **planning only** — no implementation started. This document is the
output of a source-grounded survey (CHANGELOG, release notes, upgrade-recipe
skills, direct diffs against `vendor/prisma`, and direct inspection of
published npm tarballs), not a guess. Every claim below cites the file or
command it came from. Implementation lands as a **stack of PRs** — see §8 —
so each phase below is written to be picked up by a fresh agent session that
has read only this document and the phase's own `PLAN_8.x_*.md` (once that
exists; see §9's note on per-phase docs).

## Before you start — read this first

1. **Two independent version counters — don't confuse them.** `npm view
prisma@next version` returns **`8.0.0-rc.7`**, which looks like it's
   three releases past this plan's `8.0.0-rc.4` target — but it isn't the
   same counter. The `prisma` binary is published from a _separate_
   repository (`prisma/prisma-cli`, not `vendor/prisma`) that bundles
   several independently-versioned products (`npm view prisma@next
dependencies` lists `@prisma/composer-cli`, `@prisma/compute-sdk`,
   `@prisma/credentials-store`, `@prisma/management-api-sdk` alongside
   `@prisma/orm-toolchain`) and iterates on its own faster cadence. The ORM
   surface this plan actually depends on — confirmed via `npm view
@prisma/orm-framework dist-tags` / `@prisma/orm-toolchain dist-tags` /
   `@prisma/orm-postgres dist-tags`, all three returning `{"latest":
"8.0.0-rc.4", "dev": "8.0.0-rc.4-dev.16"}` with no rc.5/6/7 published at
   all — **is genuinely current at `8.0.0-rc.4`**. `prisma@next`'s own
   `dependencies` field confirms this from the other direction: even at
   CLI version `8.0.0-rc.7`, it depends on `@prisma/orm-toolchain:
8.0.0-rc.4` exactly. `vendor/prisma`'s git tags topping out at `rc.4` is
   consistent with this, not evidence of a stale clone.
   **What's still real and worth checking before Phase 8.1 locks a pin**:
   `vendor/prisma/docs/releases/v8.0.0-rc.5.md` exists (drafted, no git tag
   yet) and the `8.0.0-rc.4-to-8.0.0-rc.5` upgrade-recipe skill directory
   already exists too — an ORM rc.5 is clearly coming. Before Phase 8.1
   starts, re-run `git -C vendor/prisma fetch --tags && git -C vendor/prisma
pull origin main`, and re-run the three `dist-tags` checks above — if
   `@prisma/orm-framework`'s `latest` has moved past `rc.4` by then, redo
   the targeted parts of this survey (§3's breaking-changes list and §6's
   exports-map table) against the new version using the same method
   documented here, and confirm the new pin with the user rather than
   silently re-targeting.

   **Done, 2026-08-22, at the start of Phase 8.1**: re-ran the fetch/pull
   and all three `dist-tags` checks — still genuinely `rc.4` (`latest` on
   all three ORM packages, no `v8.0.0-rc.5` git tag yet despite the drafted
   release notes). The pin stands; no re-survey was needed. Also verified,
   since this section's wording was ambiguous on one point: `npm view
@prisma/{orm-framework,orm-toolchain,orm-postgres}@8.0.0-rc.4 exports
--json` against the actual published tarballs (not `vendor/prisma`'s
   `main`, which is ahead of the `rc.4` tag) — **§6's mapping table is
   exactly correct as written**, including the `framework-components/X` →
   `orm-framework/components/X` double-segment. Also discovered:
   `@prisma/orm-toolchain@8.0.0-rc.4` has `@prisma/cli-engine: "0.2.0"` as
   a **hard, non-optional peerDependency** (absent from
   `peerDependenciesMeta`) — since this repo's `.npmrc` sets
   `strict-peer-dependencies=true`, every package.json that depends on
   `orm-toolchain` needs `@prisma/cli-engine@0.2.0` pinned alongside it or
   `pnpm install` fails. See `PLAN_8.1_mechanical_import_rewrite.md` for
   the full account, including four newly-discovered breaking changes not
   in §3 below and the CLI-death finding that led Phase 8.3 to descope
   "re-emit every contract" out of itself entirely — see `PLAN_8.3
_contract_layer.md` §0 — rather than reorder 8.3 after 8.5; the re-emit
   step now lives in 8.5's own row in §9.

2. **This plan is Tier 1 + the CLI (§2, §5) only.** Tier 2
   (`apps/prisma-idb-kanban-example`'s Postgres/SQL side) is
   deliberately out of scope here — see §7 decision 4.
3. **Implementation happens in a stacked PR chain**, not one big branch.
   Read §8 before opening the first PR — it has the exact tooling, commands,
   validation commands, and the phase→stack-layer mapping.
4. **The build-staleness trap will bite Phase 8.1 directly.** This repo's
   own rule (confirmed in `vendor/prisma/CLAUDE.md`'s Golden Rules, and
   hit repeatedly in this repo's own history per the
   `project-prisma-next-bugs` memory): after changing a workspace package
   that others depend on, `pnpm test` (vitest/esbuild strips types) and
   even `pnpm check`/`tsc --noEmit` can pass against a **stale** built
   `dist/*.d.mts` in a downstream package — neither command rebuilds
   dependencies for you. Phase 8.1 rewrites imports across nine
   interdependent packages in dependency order (`target-idb` →
   `family-idb` → `adapter-idb`/`driver-idb` → `runtime-idb` →
   `client-idb` → `sync-extension-idb` → `sync-server`/`sync-server-sql`).
   Rebuild each package (`pnpm --filter @prisma-next-idb/<name> build`)
   immediately after changing it and before moving to the next one in the
   chain, or a downstream package's "clean" typecheck is meaningless.

## 0. Where we are, where we're going

We're pinned to `^0.16.0` of the `@prisma-next/*` npm scope (frozen — no more
releases will ever land there). Upstream (`prisma/prisma`, formerly
`prisma/prisma-next`) has shipped several more releases past that point —
`0.17.0`, `8.0.0-rc.1` through **`8.0.0-rc.4`, the newest version actually
published for the ORM packages this plan depends on** (see the "two
independent version counters" callout above — the unified `prisma` CLI
binary iterates faster and separately, currently at `8.0.0-rc.7`, but that
doesn't mean the ORM surface has moved) — and retired the `@prisma-next/*`
scope entirely in favor of `@prisma/*`. This document's detailed survey
(§3, §6) is scoped against **`8.0.0-rc.4`**, which is both the newest tag
in our `vendor/prisma` checkout and the newest version on npm for
`@prisma/orm-framework`/`@prisma/orm-toolchain`/`@prisma/orm-postgres` as
of this survey — genuinely current, not stale, subject only to the
pre-8.1 re-check described above (an ORM rc.5 is clearly coming, just not
here yet).

Confirmed on the npm registry (not just present in the source tree — rc.3's
own release note warns that source-tree `private: false` and actual npm
publication can diverge mid-transition: _"`npx prisma@next` currently fails
on import"_ because the registry lagged the engine version the CLI was built
against): `@prisma/orm-framework@8.0.0-rc.4`, `@prisma/orm-toolchain@8.0.0-rc.4`,
and `@prisma/orm-postgres@8.0.0-rc.4` all resolve real tarballs on the
registry as of this survey. Toolchain floors also clear: rc.4 declares
`engines.node >=24` / `peerDependencies.typescript >=5.9`; this repo runs
Node `v24.13.0` and TypeScript `^6.0.3` — no prerequisite upgrade needed
before 8.1 opens.

## 1. The gate: does our dependency surface still exist? — Resolved

Before scoping any actual work we checked whether every package we depend on
still has a published home. It does. All nine `@prisma-next/*` packages we
use are `private: true` under `@internal/*` names in the rc.4 tree, but each
is re-exported through exactly one of two public aggregate packages via
subpath exports:

| Current (`^0.16.0`)                 | rc.4 home                                                                                                                                                                                  | Evidence                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `@prisma-next/contract`             | `@prisma/orm-framework/contract` (+ subpaths: `types`, `hashing`, `validate-domain`, `contract-validation-error`, …)                                                                       | `packages/9-public/@prisma/orm-framework/package.json` exports map |
| `@prisma-next/framework-components` | `@prisma/orm-framework/components` (+ `/control`, `/runtime`, `/execution`, `/codec`, `/emission`, `/utils`, `/ir`, `/psl-ast`, `/components`)                                             | same                                                               |
| `@prisma-next/ids`                  | `@prisma/orm-framework/ids` (+ `/runtime`)                                                                                                                                                 | same                                                               |
| `@prisma-next/config`               | `@prisma/orm-framework/config` (+ `/config-types`, `/config-validation`)                                                                                                                   | same                                                               |
| `@prisma-next/psl-parser`           | `@prisma/orm-framework/psl-parser` (+ `/interpret`, `/syntax`, `/tokenizer`, `/format`)                                                                                                    | same                                                               |
| `@prisma-next/utils`                | `@prisma/orm-framework/utils` (+ `/canonical-stringify`, `/hash-content`, `/result`, …)                                                                                                    | same                                                               |
| `@prisma-next/config-loader`        | `@prisma/orm-toolchain/config-loader`                                                                                                                                                      | `packages/9-public/@prisma/orm-toolchain/package.json` exports map |
| `@prisma-next/migration-tools`      | `@prisma/orm-toolchain/migration-tools` (+ `/hash`, `/invariants`, `/io`, `/metadata`, `/migration`, `/spaces`, `/aggregate`, `/graph`, `/refs`, `/errors`, `/contract-snapshot-store`, …) | same                                                               |
| `@prisma-next/postgres`             | `@prisma/orm-postgres` (+ `/config`, `/runtime`, `/adapter`, `/driver`, …) — a much larger single-target aggregate, only used by `sync-server-sql`                                         | `packages/9-public/@prisma/orm-postgres/package.json` exports map  |

This matches the extension-author upgrade recipe's own framing exactly (see
`vendor/prisma/skills/prisma-8-extension-upgrade/upgrades/0.16-to-0.17/instructions.md`,
entry `build-against-published-packages-not-workspace-names`): _"Each internal
package became a subpath entrypoint of exactly one of those [public
aggregates] — the module you imported still exists under a new name, the
mapping is one hop and the symbols are unchanged."_ This is a real port, not
a restructuring project or a "wait for GA" conversation.

**One structural fact worth internalizing**: we are a third-party target
(IndexedDB) that consumes only the _framework_ layer
(`@prisma-next/{contract,framework-components,ids,config,config-loader,migration-tools,psl-parser,utils}`)
plus, in one app-tier dependency, the _Postgres target aggregate_. We do
**not** import from `@internal/sql-contract`, `@internal/sql-schema-ir`,
`@internal/target-postgres`, or any other SQL-family-internal package —
`target-idb`/`family-idb` implement IDB's storage model from scratch, the
same way the Mongo family does. This matters a lot for scoping the next
section.

## 2. Scope tiers

**Tier 1 — our library packages** (`packages/prisma-orm/{adapter,client,driver,family,runtime,sync-extension,sync-server,target}-idb`,
and `sync-server-sql`): touch only the framework-generic surface above. The
large SQL-family-specific breaking changes in the CHANGELOG (CHECK-constraint
IR reshape, RLS wire-naming, SQL index name-identification, Postgres native
type authoring, `pg/*` codec JSON-form changes, aggregate-registry
construction) **do not reach this tier** — verified by grep, not assumed (see
§6).

**Tier 2 — `apps/prisma-idb-kanban-example`**: this demo app is
dual-stack. It has an IDB side (`migrations/`) _and_ a full Postgres/SQL
side (`migrations-postgres/`, `prisma-next.config.postgres.ts`), and its
`package.json` pulls in the entire SQL family directly: `@prisma-next/{sql-builder,
sql-contract, sql-contract-psl, sql-orm-client, sql-relational-core,
sql-runtime, sql-contract-emitter, target-postgres, adapter-postgres,
driver-postgres, family-sql}`. Every SQL-specific breaking change in the
CHANGELOG **does** apply here. This is a materially bigger and different job
than Tier 1 and is **deferred** — see §7 decision 4.

**Tier 3 — `apps/prisma-orm-usage`**: IDB-only demo, same surface as Tier 1.

**Out of scope, confirmed**: `packages/generator` (the legacy
pre-prisma-next generator, pinned to `@prisma/client ^6||^7` — unrelated
lineage, not part of this port) and `apps/docs` (no `@prisma-next` runtime
dependency, just documents the API).

## 3. Concrete breaking changes that reach Tier 1

Filtered from the five relevant upgrade-recipe hops
(`0.16→0.17`, `0.17→rc.1`, `rc.1→rc.2`, `rc.2→rc.3`, `rc.3→rc.4`, both the
user and extension-author skill variants) against what we actually import
and construct. SQL/RLS/index/CHECK/pg-codec items are excluded per §2 — verified
via the `extensionPacks`, `instanceof`, aggregate, and `RuntimeCore` greps in
§6, not assumed. **Subject to the pre-8.1 re-check in the "before you
start" callout** — if an ORM rc.5 (or later) has published by the time
Phase 8.1 starts, redo this section's survey for the new hop before
treating it as complete.

1. **Package scope retirement — mechanical, wide.** `@prisma-next/*` →
   `@prisma/orm-framework` / `@prisma/orm-toolchain` per the table in §1.
   ~27 distinct import specifiers across `packages/prisma-orm/*/src`
   (full inventory below). No symbol renames within this move — only the
   package/subpath name changes.

2. **`sha256:` prefix dropped from every content hash** (`0.16→0.17`,
   PR prisma-next#1033). `storageHash`/`profileHash` values are unchanged
   (only the textual prefix drops); `migrationHash` values **change**
   because the hashed manifest bytes embed the `from`/`to` hash strings.

   **Correction from Phase 8.2** (see
   `PLAN_8.2_content_hash_migration_tree.md` §0 for the full evidence): the
   "clean break with no fallback reader" claim below, and the store-layout
   conversion step it motivates, do **not** apply to Tier 1 — and per
   [ADR 240](../../../vendor/prisma/docs/architecture%20docs/adrs/ADR%20240%20-%20Contract%20snapshots%20live%20in%20a%20content-addressed%20store.md)
   (Accepted), the claim overstates even rc.4's own reference behavior:
   the content-addressed store is authoring/planning surface only —
   `migration apply` reads only `migration.json`/`ops.json` and never
   touches `snapshots/`, and ADR 240 says a project can delete
   `migrations/snapshots/` entirely and still migrate an app-space chain
   end-to-end. Separately, Tier 1 never calls `readMigrationPackage`
   (`@prisma/orm-toolchain/migration-tools/io`) at all — our authoring
   pipeline (`family-idb/src/core/migration-plan.ts`) hand-rolls
   sibling-file reads/writes for `end-contract.json`/`.d.ts` and never
   adopted the public snapshot-store API; our runtime
   (`contract-space.generated.ts`) only ever imports `migration.json`/
   `ops.json` into `contractSpaceFromJson`, whose rc.4 signature takes no
   snapshot-store input at all. The vendor migrator script
   (`scripts/migrate-migrations-layout.mjs`) is also not runnable from this
   repo as written — it imports `@internal/*` packages that only resolve
   inside `vendor/prisma`'s own uninstalled workspace. Phase 8.2 therefore
   only ran the prefix-strip codemod (self-contained, no `@internal/*`
   imports) against the 3 Tier-1 migration roots. Adopting the
   content-addressed store is real, ADR-240-faithful architectural debt
   worth paying down — scoped as its own deferred **Phase 8.9** in §9,
   not folded into 8.2 and not a blocker for the rc.4 port.

   Two concrete, already-located consequences (the first — the prefix
   fix — is now done; the second — the store-layout conversion — is the
   corrected item above):
   - `packages/prisma-orm/client-idb/src/core/migration-hash.ts` is a
     hand-maintained browser-safe reimplementation of the framework's
     `computeMigrationHash` (WebCrypto instead of Node's `createHash`,
     because `node:crypto` doesn't exist in the browser). It still returns
     `` `sha256:${outer}` `` (line 43) — this must become bare hex. **The
     prefix is the easy half of this fix.** The dangerous half: our
     comment pins the algorithm to "v0.12.0 manifest semantics," and the
     manifest gained `ownership`/`destinationContractJson` fields and the
     snapshot store moved twice since then. Before trusting the port, diff
     our 44-line implementation against
     `vendor/prisma/packages/1-framework/3-tooling/migration/src/**/hash*`
     at rc.4, and add a test that compares our browser-computed hash
     against a `migrationHash` the real CLI recorded for the same
     migration — neither typecheck nor our current suite would catch a
     silent algorithm divergence.
   - Every checked-in migration tree we ship
     (`apps/prisma-idb-kanban-example/migrations/`,
     `apps/prisma-orm-usage/migrations/`,
     `packages/prisma-orm/sync-extension-idb/migrations/`, plus the
     `-postgres` tree) uses the **old sibling-snapshot layout**
     (`start-contract.json`/`end-contract.json`/`.d.ts` siblings inside
     each migration package, `sha256:`-prefixed hashes throughout,
     ref-paired `refs/*.contract.json`) — confirmed by grep. `0.17`
     replaced this with a single content-addressed store per migrations
     root (`migrations/snapshots/<hex>/contract.{json,d.ts}`). This is a
     **clean break with no fallback reader** — an unconverted tree fails
     to load entirely once the toolchain is upgraded. Conversion order
     matters and is prescribed by the recipe: (a) run the colocated
     `strip-sha256-hash-prefixes.ts` codemod first — the layout migrator
     only accepts bare-hex trees; (b) then run
     `node scripts/migrate-migrations-layout.mjs <migrationsRoot>` from a
     `vendor/prisma` checkout at rc.4, once per migrations root (four
     roots to convert); (c) re-verify every `migrationHash` is unchanged
     after conversion (the migrator does this itself and aborts on
     mismatch before writing anything). Confirmed the migrator script
     still exists in the rc.4 tree at
     `vendor/prisma/scripts/migrate-migrations-layout.mjs` (plus its own
     test file and two regen helpers) — it was not deleted once the 0.17
     transition completed, so no fallback recovery (`git show
v0.17.0:scripts/migrate-migrations-layout.mjs`) is needed.

3. **`extensionPacks` → `extensions`** (`0.16→0.17`, PR prisma-next#1032).
   Hard break, no compat alias. Confirmed present in our own
   contract-authoring code: `packages/prisma-orm/family-idb/src/core/
psl-interpreter.ts` and `contract-builder.ts` both referenced
   `extensionPacks`; **fixed in Phase 8.3** (see `PLAN_8.3_contract_layer.md`).

   **Correction from Phase 8.3**: the claim that the key "sits in the hashed
   contract bytes, so every contract's `storageHash`/`executionHash`/
   `profileHash` changes on re-emit" is wrong. Confirmed directly against
   the installed rc.4 `.d.mts`: `computeStorageHash({ target, targetFamily,
storage })`, `computeProfileHash({ target, targetFamily, capabilities })`,
   and `computeExecutionHash({ target, targetFamily, execution })` each take
   only the named fields as input — none accepts `extensions`/`extensionPacks`
   at all, and the canonicalization module they share has no reference to
   either name either. The rename is hash-inert: once contracts are
   re-emitted (Phase 8.5, once `contract emit` works against rc.4-shaped
   config), every `storageHash`/`profileHash`/`executionHash` will be
   byte-identical to today's checked-in values. This also means the
   currently-stale checked-in `contract.json`/`contract.d.ts` files (still
   `extensionPacks: {}`) carry no hash risk in the meantime — `migration-
plan.ts`'s head-check (which compares hashes by literal string equality)
   is unaffected by this rename either way. What the staleness _does_ break
   today: `apps/prisma-idb-kanban-example`'s `svelte-check` (7 errors,
   `Property 'extensions' is missing in type 'Contract'`) — confirmed
   pre-existing (present before Phase 8.3's rename too, via a stash-and-diff
   check), not a regression, but a concrete symptom of the same "re-emit is
   blocked until 8.5" fact PLAN_8.1 §3 already established. `apps/
prisma-next-usage`'s `svelte-check` has the identical stale field in its
   own `contract.d.ts` but doesn't hit the error, since its app code doesn't
   assert the JSON-imported contract against `IdbContract`/`Contract<IdbStorage>`
   as strictly as kanban's `db.ts` does.

   Two smaller riders in the same PR: `contract.source.sourceFormat` →
   `format`, `outputPath` → `output` on facade `defineConfig` — **checked
   against our config plumbing in Phase 8.3: neither key appears anywhere
   in Tier 1's config files, so there was nothing to change.**

   **Correction from Phase 8.5**: "hash-inert" is wrong, measured directly
   rather than re-derived from the type signatures above. Wrapped
   `apps/prisma-orm-usage`'s existing config in the rc.4 envelope and ran
   the real `prisma@rc.7 contract emit` against it: `storage.stores`/
   `namespaces`/`capabilities` came back byte-identical to the checked-in
   contract, `extensionPacks`→`extensions` (both `{}`) was the only visible
   change — yet `storageHash` and `profileHash` both changed anyway. The
   inputs to `computeStorageHash`/`computeProfileHash` are exactly what
   this section says (verified identical between old and new), so the
   change is in the vendor's hashing implementation itself somewhere
   between the frozen-0.16.0-era build and rc.4 — not in our contract, and
   not something this document's type-signature argument could have caught.
   This means re-emitting any Tier-1 contract with a _committed_ migration
   chain invalidates that chain's `end-contract.json` until the chain is
   regenerated — which is why Phase 8.5 only re-emitted `sync-server-sql`'s
   (gitignored, no committed chain) and deferred every other package's
   re-emission to Phase 8.6. See `PLAN_8.5_cli_config_unification.md` §0
   for the full evidence and the per-package committed-chain inventory.

4. **Structured error scheme, dotted `NAMESPACE.SUBCODE` codes**
   (`0.16→0.17`). Legacy classes (`PslFormatError`, `SqlEscapeError`,
   `ConfigFileNotFoundError`, `ConfigValidationError`,
   `DomainNamespaceResolutionError`, `SupabaseConfigError`,
   `InvalidJwtError`) are deleted in favor of `isStructuredError(error) &&
error.code === '…'`. We grepped our own `src/` for `instanceof …Error`
   checks and found none against a framework-owned error class (our few
   hits are plain `instanceof Error`, unaffected) — so this is a
   **read-through, not a required source change**, but re-verify at
   implementation time since new code may have been added since this
   survey (2026-08-22).

5. **CLI/config unification** (`rc.1→rc.2`, hard-cut in `rc.3→rc.4`).
   `prisma-next.config.ts` and the flat (un-nested) config shape are
   **fully removed** as of rc.4 — no more deprecation-warning fallback.
   Confirmed present: `apps/prisma-idb-kanban-example/prisma-next.config.ts`
   and `apps/prisma-orm-usage/prisma-next.config.ts` both need the
   rename + `definePrismaConfig({ orm: ormConfig({ …existing… }) })`
   envelope wrap, plus a new `@prisma/cli-engine` devDependency (confirmed
   published: `npm view @prisma/cli-engine` lists `latest: 0.0.9` but
   `dev: 0.2.0` — the exact `0.2.0` `@prisma/orm-toolchain@8.0.0-rc.4`'s
   peer wants is on the `dev` dist-tag, not `latest`; pin the exact
   version string, not a tag or range). Separately: the `prisma-next` bin
   is retired repo-wide — **our own bin**,
   `packages/prisma-orm/family-idb/src/bin/prisma-idb.ts`, is no
   longer an open question — see §5 and §7 decision 2 for the resolved
   direction (mount into a `@prisma/cli-engine` shell, don't just keep a
   bespoke standalone bin as-is).

6. **Count-only mutation terminals `createCount`/`updateCount`/`deleteCount`
   → `createAndCount`/`updateAndCount`/`deleteAndCount`** (`0.16→0.17`).
   This is upstream's own ORM naming; it does **not** rename a symbol we
   import — `client-idb`'s `createCount`/`updateCount`/`deleteCount` in
   `core/types.ts`/`core/store-accessor.ts` is _our own_ independently
   chosen public API surface, mirroring the old convention. No forced
   break. Optional terminology-alignment decision, not scoped into this
   plan.

7. **Aggregate restructuring across `0.17→rc.1→rc.2`** (bigint round-trip,
   then reverted to native numbers + lossless `*BigInt`/`avgDecimal`
   variants, contract-derived `AggregateTypes` block). Verified **not
   applicable**: `client-idb/src/core/aggregate-builder.ts` is a fully
   hand-rolled `count`/`sum`/`avg`/`min`/`max` implementation that mirrors
   the vendor `sql-orm-client/aggregate-builder.ts` shape but does not
   derive from the contract's `AggregateTypes` block or construct an
   `ExecutionContext.aggregateDescriptors` registry (confirmed by grep —
   `AggregateTypes`/`aggregateDescriptors` appear nowhere in our source).
   No compile break. Worth a deliberate design conversation later about
   whether to adopt the same lossless-numeric convention for consistency,
   but it's not a migration requirement.

## 4. The one real engineering problem: `RuntimeCore`'s query()/execute() split

This is the item the mechanical import-rewrite framing would miss, and it's
the single largest actual risk in this port. Confirmed by reading the actual
rc.4 source against our actual subclass, not inferred from the changelog
prose.

**What changed upstream.** Confirmed directly against our installed 0.16.0
package (`node_modules/.pnpm/@prisma-next+framework-components@0.16.0_*/…/dist/runtime.d.mts`,
not inferred from our subclass shape): at 0.16.0, `RuntimeCore` defines
"the entire `execute(plan)` template in one place" — a single concrete
`execute()` backed by one abstract `runDriver()` hook and one middleware
chain (`beforeExecute`/`runDriver`/`onRow`). At rc.4
(`execution/runtime-core.ts`) it is genuinely two orthogonal template-method
pairs:

- `query<Row>(plan, options?): AsyncIterableResult<Row>` — **concrete**,
  calls the abstract `runDriver(exec): AsyncIterable<Record<string, unknown>>`
  hook, runs the `beforeQuery`/`interceptQuery`/`onRow`/`afterQuery`
  middleware chain.
- `execute(plan, options?): Promise<RuntimeStatementStats>` — **concrete**,
  calls a _new_ abstract `runExecute(exec): Promise<RuntimeStatementStats>`
  hook, runs the separate `beforeExecute`/`interceptExecute`/`afterExecute`
  chain, and returns `{ affectedRows }` — not rows.

**What this breaks in `runtime-idb`.**
`packages/prisma-orm/runtime-idb/src/idb-runtime.ts`'s `IdbRuntimeImpl`
directly subclasses `RuntimeCore<IdbQueryPlan, IdbPlanBody, IdbMiddleware>`
and currently:

```ts
// current (line 228)
override execute<Row>(
  plan: IdbQueryPlan & { readonly _row?: Row },
  options?: RuntimeExecuteOptions
): AsyncIterableResult<Row> {
  return super.execute(plan, options);
}
```

This override's return type (`AsyncIterableResult<Row>`) directly conflicts
with the base class's new `execute()` signature
(`Promise<RuntimeStatementStats>`) — a hard TypeScript incompatible-override
error, not a warning. The fix is not a rename-in-place: `runDriver()` (already
implemented at line 215, delegating to `this.#driver.execute(exec)`) stays as
is and now backs the base class's _new_ `query()` — so the override above
should simply be **deleted**, letting `query()` inherit from the base class.
What's genuinely new work is implementing `runExecute(exec):
Promise<RuntimeStatementStats>` — IDB has no native "affected-row count
without returning rows" concept, so this needs a real design decision (most
likely: drain `runDriver`'s async iterable and count, or have the IDB driver
report a count directly for non-returning writes) rather than a mechanical
port. `idb-middleware.ts`'s `IdbMiddleware extends
RuntimeMiddleware<IdbPlanBody>` also needs checking against the now-split
hook shape (`beforeQuery`/`interceptQuery` vs `beforeExecute`/`interceptExecute`,
both threaded through the same `RuntimeMiddlewareContext`).

Then, **every consumer of the renamed row path** needs auditing:
`client-idb/src/core/executor.ts`'s `IdbQueryExecutor.execute()`,
`store-accessor.ts` (6+ call sites), `relation-loader.ts`, and
`sync-extension-idb/src/core/sync-executor.ts` all currently call
`.execute(plan)` expecting rows back. These are _our own_ interface names,
decoupled from `RuntimeCore` by one layer (`IdbQueryExecutor` is our own
type) — so they don't have to be renamed to `query`, but the thing they
delegate to (`IdbRuntimeImpl`) now exposes the row path under `query()`
after the fix above, so the delegation call site inside `client-idb`'s
runtime-adapter wiring changes from `.execute(...)` to `.query(...)`. Map
every one of these before starting, don't discover them mid-port —
`driver-idb/src/core/transaction-scope.ts` has a comment ("execute()
bypasses RuntimeCore's middleware") that itself needs re-reading once the
split lands, since the bypass may now be ambiguous about _which_ execute it
bypasses.

Budget this as its own review-and-test pass, not a line in a bigger diff.

## 5. CLI mounting — building on `@prisma/cli-engine`'s public primitives

**Direction confirmed by the user**: prefer mounting our commands into the
`prisma` CLI's engine over keeping a fully bespoke standalone bin. The
reasoning holds up under research — see below for what's actually possible
today and what would need upstream cooperation.

### 5.1 How the real `prisma` CLI mounts command families

From `docs/architecture docs/subsystems/11. CLI.md`: _"The published
toolchain ships no bin. The only user-facing binary is the unified `prisma`
CLI (the prisma-cli repository), which imports `ormCommandFamily` from
`@prisma/orm-toolchain/cli` and mounts it in its own `@prisma/cli-engine`
shell."_ `ADR 211` (superseded, but its supersession note confirms the
current model) says the same thing from the other direction: there is no
`prisma-next` bin anymore anywhere in the published surface; the unified
binary is the only user-facing entry point.

**This is static composition, not a runtime plugin system.** Confirmed by
unpacking `@prisma/cli-engine@0.2.0` from npm (`npm pack
@prisma/cli-engine@0.2.0`) and reading its `dist/index.d.ts` directly. The
engine exports:

```ts
declare function createCli(spec: {
  readonly name: string;
  readonly version: string;
  readonly commandFamilies: readonly CommandFamily[];
  readonly groups: Readonly<Record<string, { readonly brief: string; readonly description?: string }>>;
  readonly commands: MountedTree;
  readonly help?: { readonly tagline?: string; readonly description?: string; readonly examples?: readonly string[]; readonly docsUrl?: string };
  readonly telemetry?: TelemetryDeclaration;
}): Cli;

interface CommandFamily {
  readonly configSection: ConfigSection<unknown> | undefined;
  readonly commands: Readonly<Record<string, AnyCommand>>;
  readonly docsBaseUrl: string | undefined;
  readonly redirects: readonly CommandRedirect[];
}
declare function defineCommandFamily(spec: {
  readonly configSection?: ConfigSection<unknown>;
  readonly commands: Readonly<Record<string, AnyCommand>>;
  readonly docsBaseUrl?: string;
  readonly redirects?: readonly RedirectSpec[];
}): CommandFamily;

declare function defineCommand<TFlags, TPositionals, TConfig, TCode, TManagesCredentials, TInstallsPackages>(def: {
  /* name, flags, positionals, needs (incl. a config-section token), handler, help, … */
}): CommandDefinition</* … */>;
```

`createCli`'s `commandFamilies` is a plain array literal — whoever calls
`createCli()` decides which families are in the binary, at build time.
There is no config file, environment variable, or `node_modules` scan that
lets a family register itself into someone else's already-built `prisma`
binary at runtime. Corroborating evidence: `npm view prisma@next
dependencies` (the actual unified CLI package, confirmed on npm at
`8.0.0-rc.7`) lists `@prisma/orm-toolchain`, `@prisma/composer-cli`,
`@prisma/compute-sdk`, `@prisma/credentials-store`,
`@prisma/management-api-sdk` as direct dependencies — each is almost
certainly one more `CommandFamily` statically composed the same way
`ormCommandFamily` is. Third-party families are not among them, and there's
no indication from anything read in this survey that they could be without
`prisma/prisma-cli`'s own source adding the dependency and the array entry.

### 5.2 Two paths, ranked

**Option A — build our own `@prisma/cli-engine`-based shell (recommended,
actionable now, no upstream dependency).** `createCli`, `defineCommandFamily`,
`defineCommand`, and `definePrismaConfig` are all public, typed, published
exports of `@prisma/cli-engine` — the exact same primitives the real
`prisma` binary is built from. We can build our own bin (working name:
keep `prisma-next-idb`/successor, or pick something — this is where §7
decision 2 gets made concrete) that calls `createCli({ commandFamilies: […],
… })` with:

- our own `idbCommandFamily` (built with `defineCommandFamily`, wrapping
  `migration plan` / `migration contract-space` / `migration preflight` —
  today's `bin/prisma-next-idb.ts` commands — as `defineCommand` entries),
  and
- optionally `ormCommandFamily` itself, mounted alongside ours. **Confirmed
  importable**: unpacking `@prisma/orm-toolchain@8.0.0-rc.4` from npm and
  reading `dist/cli.d.mts` shows `declare const ormCommandFamily:
import("@prisma/cli-engine").CommandFamily;`, exported from the package's
  `/cli` subpath. Whether mounting it alongside ours is actually useful
  depends on whether any of our workflows want the generic `contract emit`/
  `db verify`/`migration new` surface next to our IDB-specific commands —
  a design question for whoever implements this phase, not resolved here.

This gets us the identical flag-parsing, help rendering, JSON output
(`@prisma/cli-engine/protocol`), structured-error rendering, and telemetry
conventions as the real `prisma` CLI — genuinely solving the "don't make
users learn two different CLI dialects" problem the user raised, even
though the bin name differs. `@prisma/cli-engine` becomes a new direct
dependency of wherever the bin lives (currently `family-idb`); pin it at
the exact `0.2.0` (see §3 item 5 — `latest` on npm is still the stale
`0.0.9`).

**Option B — get mounted inside the actual `prisma` binary (stretch,
requires upstream, not blocking).** This means `prisma/prisma-cli` (a
separate GitHub repository, **not cloned into `vendor/`** — everything in
this section came from npm package inspection, not that repo's source)
adding our command family as a dependency and an entry in its own
`createCli({ commandFamilies: […] })` call. Nothing in this survey found a
stated policy — positive or negative — on third-party target command
families being accepted there. **This is a missing-context item**: before
treating Option B as viable or dead, someone should actually look at
`https://github.com/prisma/prisma-cli` (issues, discussions,
`CONTRIBUTING.md`, or an open conversation with a maintainer) — none of
that was checked in this survey because it's a separate repo outside
`vendor/prisma`'s clone. Recommend treating Option B as a follow-up
conversation to have _after_ Option A ships and proves the UX is worth
pursuing further, not a prerequisite for Option A.

### 5.3 What's still unresolved for whoever implements this phase

- Exact shape of `defineCommand`'s handler/flags/positionals — the `.d.ts`
  read above captured the top-level signatures but not every field of
  `CommandDefinition`'s generic parameters (`FlagSpec`, `PositionalSpec`,
  `NeedsSpec`, `Handler`). Read `dist/report-BpE5F1IH.d.ts` (from the
  unpacked `@prisma/cli-engine@0.2.0` tarball, or re-`npm pack` fresh) in
  full before starting, and look at how `ormCommandFamily`'s own commands
  are defined in `vendor/prisma/packages/1-framework/3-tooling/cli/src/orm/`
  for a working, in-repo example of the full pattern (command modules,
  `family.ts` collection, `cli.ts` mounting shell) even though that
  example mounts a different family than ours.
- Bin/package naming for the new shell — ties into §7 decision 2 (deferred
  in this doc, resolve when this phase starts).
- Whether `definePrismaConfig`'s single recognized-sections model (_"the
  recognised section names are exactly the ones the CLI's command families
  declare"_) means our own `idbCommandFamily` needs its own `configSection`
  (via `defineConfigSection`) for anything to be configurable through
  `prisma.config.ts` — almost certainly yes if we want e.g. a
  `definePrismaConfig({ idb: idbConfig({ … }) })` shape, but not derived
  in this survey.

## 6. Full import inventory (Tier 1, mechanical rewrite checklist)

Grepped from `packages/prisma-orm/*/src` (module-path granularity — exact
symbol-level detail belongs in the implementation pass, not this plan):

```
@prisma-next/config-loader                          → @prisma/orm-toolchain/config-loader
@prisma-next/config/config-types                     → @prisma/orm-framework/config/config-types
@prisma-next/contract/contract-validation-error       → @prisma/orm-framework/contract/contract-validation-error
@prisma-next/contract/hashing                         → @prisma/orm-framework/contract/hashing
@prisma-next/contract/types                           → @prisma/orm-framework/contract/types
@prisma-next/contract/validate-domain                 → @prisma/orm-framework/contract/validate-domain
@prisma-next/framework-components/codec               → @prisma/orm-framework/components/codec
@prisma-next/framework-components/components          → @prisma/orm-framework/components/components
@prisma-next/framework-components/control             → @prisma/orm-framework/components/control
@prisma-next/framework-components/emission            → @prisma/orm-framework/components/emission
@prisma-next/framework-components/execution           → @prisma/orm-framework/components/execution
@prisma-next/framework-components/runtime             → @prisma/orm-framework/components/runtime
@prisma-next/framework-components/utils               → @prisma/orm-framework/components/utils
@prisma-next/ids/runtime                              → @prisma/orm-framework/ids/runtime
@prisma-next/migration-tools/hash                     → @prisma/orm-toolchain/migration-tools/hash
@prisma-next/migration-tools/invariants                → @prisma/orm-toolchain/migration-tools/invariants
@prisma-next/migration-tools/io                        → @prisma/orm-toolchain/migration-tools/io
@prisma-next/migration-tools/metadata                  → @prisma/orm-toolchain/migration-tools/metadata
@prisma-next/migration-tools/migration                 → @prisma/orm-toolchain/migration-tools/migration
@prisma-next/migration-tools/spaces                    → @prisma/orm-toolchain/migration-tools/spaces
@prisma-next/postgres/config                           → @prisma/orm-postgres/config     (sync-server-sql only)
@prisma-next/psl-parser                                → @prisma/orm-framework/psl-parser
@prisma-next/psl-parser/interpret                      → @prisma/orm-framework/psl-parser/interpret
@prisma-next/psl-parser/syntax                         → @prisma/orm-framework/psl-parser/syntax
@prisma-next/utils/canonical-stringify                 → @prisma/orm-framework/utils/canonical-stringify
@prisma-next/utils/hash-content                        → @prisma/orm-framework/utils/hash-content
@prisma-next/utils/result                              → @prisma/orm-framework/utils/result
```

Note the added `components/` segment on every `framework-components/*` →
`orm-framework/components/*` mapping — this is not a 1:1 string substitution
of the package name alone.

`package.json` changes, per package under `packages/prisma-orm/*`: drop
every `@prisma-next/*` dependency entry, add `@prisma/orm-framework` and/or
`@prisma/orm-toolchain` (and `@prisma/orm-postgres` for `sync-server-sql`),
each pinned to the exact `8.0.0-rc.4` (not caret) — **pending the
version-drift re-check at the top of this document**.

## 7. Open decisions

Status as of this update — some resolved by the user, some explicitly
deferred. Don't re-litigate a "deferred" item without the user raising it
again; don't treat a "deferred" item as "decided against," either — it's
genuinely open, just not blocking Phase 8.1–8.7.

1. **Package naming — DEFERRED, keep as-is.** We publish `@prisma-next-idb/*`
   at `0.5.0`/`0.3.0`/`0.2.0`. `prisma-next` as a brand is retired
   upstream, but the user has explicitly postponed this decision. **Do not
   rename any of our own package names in this port** — every phase below
   should assume `@prisma-next-idb/*` stays exactly as it is today. Revisit
   only if the user raises it again.
2. **Our own CLI bin's fate — DIRECTION SET, implementation detail open.**
   The user prefers mounting over a bespoke standalone CLI — see §5 for
   the full research. Concretely: pursue §5's Option A (our own
   `@prisma/cli-engine`-based shell) as its own phase (8.6). The exact bin
   name/package location for that shell is not decided here — resolve it
   when Phase 8.6 starts, informed by §5.3's open questions.
3. **`packages/generator` scope — CONFIRMED out of scope.** Unrelated
   lineage (`@prisma/client ^6||^7`, the pre-prisma-next generator). Not
   touched by this port.
4. **Tier 2 (`apps/prisma-idb-kanban-example`'s Postgres side)
   scheduling — DONE, see Phase 8.8.** This decision originally deferred
   Tier 2 pending a full scoped survey, expecting the whole SQL-family
   CHANGELOG (CHECK constraints, RLS wire-naming, index name-identification,
   `pg/*` codec JSON-form changes, aggregate restructuring, the Postgres
   side of the query/execute split) to apply. The survey (grep-verified,
   not assumed) found kanban's actual code only touches a narrow slice of
   that surface — no RLS, no aggregates, no raw-lane usage — and the user's
   call was to land the full port as one phase rather than decompose it
   further. See `PLAN_8.8_postgres_port.md`.
5. **Version pinning strategy — DEFERRED, still open.** This draft
   recommends pinning `8.0.0-rc.4` exact (not `^8.0.0-rc.4`), and `rc.4`
   _is_ confirmed current for the ORM packages this plan depends on (see
   the "two independent version counters" callout — don't be misled by
   `prisma@next` itself already being at `rc.7`, that's a different
   product's version counter). What's still genuinely open: whether to
   treat each subsequent ORM rc as its own scoped follow-up survey (this
   document's own recommendation) versus some other cadence, and whether
   "exact pin everywhere" stays right once the CLI-mounting work (§5)
   adds `@prisma/cli-engine` as a new, separately-versioned dependency.

## 8. Implementation workflow: stacked pull requests

GitHub shipped native stacked pull requests to public preview on
2026-07-30 — an ordered series of PRs, each one layer of a larger change,
independently reviewable, auto-rebased server-side as lower PRs merge, and
mergeable as a unit. This is a genuinely new GitHub feature (public preview,
~3 weeks old as of this document); if anything below doesn't match what
`gh stack --help` or the linked docs say when you read this, trust the live
tool/docs over this section and update it.

**Docs**: [Quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart),
[CLI command reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands),
[Managing stacked PRs](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests).

### 8.1 Prerequisites

- `gh` CLI ≥ 2.90.0 — confirmed installed here at `2.97.0`.
- Git ≥ 2.20 — confirmed installed here at `2.55.0`.
- Install the extension once per machine/session: `gh extension install
github/gh-stack` (not yet installed as of this survey — run this before
  the first phase starts).
- For agent sessions specifically, also run `gh skill install
github/gh-stack` — the feature is explicitly wired up for coding agents
  via this skill.

### 8.2 Phase → stack mapping

One stack, phases as layers, in the dependency order from §9's table.

**Correction from Phase 8.1** (see `PLAN_8.1_mechanical_import_rewrite.md`
§3 for the full evidence): 8.3's "re-emit every contract" step needs a
working `contract emit`, and the only CLI capable of that against
rc.4-shaped config is what 8.5/8.6 build — the `prisma-next@0.16.0` CLI we
have today is confirmed dead against rc.4 packages. **8.5 must precede
8.3**, not follow it as drawn below. The diagram and §9's table are left
as originally written pending whoever picks up the reorder actually
restructuring the stack; treat 8.5-before-8.3 as the real dependency until
then.

```
main
 └─ 8.1  mechanical import/package rewrite
     └─ 8.2  content-hash + migration-tree conversion
         └─ 8.3  contract-layer breaks (extensionPacks→extensions, error codes)
             └─ 8.4  RuntimeCore query()/execute() split
                 └─ 8.5  CLI/config unification (prisma.config.ts rename)
                     └─ 8.6  CLI mounting (§5 Option A)
                         └─ 8.7  full validation pass
```

**Correction from Phase 8.8**: this section originally said Phase 8.8
(Tier 2) was not part of this stack and should be its own stack once
scoped. In practice it landed stacked directly on `phase-8.7-full-validation`
(user's call) — kanban's `package.json` had already mixed rc.5
`orm-framework`/`orm-toolchain` with 0.16.0 SQL-family packages on this
open stack (from 8.6.1's IDB-side fix), a state `main` doesn't have, so
basing 8.8 off `main` wasn't practical until the whole stack merges. See
`PLAN_8.8_postgres_port.md`.

Note that 8.2, 8.3, and 8.4 are, per §9's dependency column, _siblings_ —
each depends only on 8.1, not on each other. A stack is linear, so serializing
them into one chain (as drawn above) is a forced choice, not a discovered
constraint: it means churn in 8.2 or 8.3 rebases 8.4 (the risky one, per §4)
on top of it even though they touch unrelated code. If parallel review
matters more than a single simple chain, 8.2/8.3/8.4 could instead be three
separate stacks off `main` (each rejoining before 8.5, which genuinely does
depend on 8.1 _and_ 8.3). This document doesn't decide that trade-off —
whoever starts Phase 8.1 should pick based on how much reviewer bandwidth
is available in parallel versus how much rebase churn is tolerable.

Each phase should land as one PR in the stack — see §9 for what "done"
looks like per phase. If a phase turns out too large for one reviewable PR
(8.4 and 8.6 are the likely candidates, per their own sections above), split
it into sub-layers (`8.4a`, `8.4b`, …) rather than cramming it into one
diff — the whole point of the stack is that each layer stays small and
independently reviewable.

### 8.3 Commands, end to end

**Starting the stack** (once, at the start of Phase 8.1):

```
gh stack init -b main
# name the first branch/layer, e.g. phase-8.1-import-rewrite
```

**Working within a phase** (any phase, any session):

```
git commit -m "…"              # normal commits, as many as needed
gh stack push                   # push the active branch(es) to origin
gh stack submit                 # create/update the PR(s), correct base targeting
```

Or, to stage+commit+advance to the next layer in one step when starting a
new phase on top of the current one:

```
gh stack add -Am "start phase 8.2: migration-tree conversion" phase-8.2-migration-hash
```

**Resuming in a fresh agent session** (this is the common case — a new
session picking up a phase that a previous session started or that's next
in the stack):

```
gh stack view                   # see every layer, its PR, status, latest commit
gh stack checkout <phase-branch-or-PR-number>
```

`gh stack view` is the first command any fresh session should run against
this repo's stack — it's the fastest way to answer "what phase is done,
what's in review, what's next" without reading PR descriptions one by one.

**When a lower phase's PR merges**: GitHub auto-rebases and retargets every
PR above it server-side — nothing to do on GitHub's side. Locally, sync
before continuing work on the next phase:

```
gh stack sync                   # fetch, rebase remaining branches, push, sync PR state
```

(`gh stack rebase` does the cascading rebase alone, without the fetch/push/
sync-state steps, if finer control is needed — e.g. mid-conflict resolution
with `gh stack rebase --continue`/`--abort`.)

**Merging**: once a phase's PR (and everything below it) is approved,
either merge normally through GitHub's UI/API per-PR (auto-rebase handles
the cascade), or use `gh stack merge <stack-number-or-PR-number>` to merge
one or more layers at once.

### 8.4 Validation commands

Root `package.json` scripts (run from repo root):

- `pnpm test:prisma-next` — the scoped test filter covering exactly Tier 1
  (`adapter-idb`, `client-idb`, `driver-idb`, `family-idb`, `runtime-idb`,
  `target-idb`, `sync-server`, `sync-server-sql`, `sync-extension-idb`,
  `cli-tests`). Prefer this over the unscoped `pnpm test` while working
  through Phases 8.1–8.6 — faster feedback, and it won't hide a Tier 1
  regression under unrelated Tier 2/generator-package noise. **One member
  of this filter needs its own extra rebuild step**: `cli-tests`
  (`tests/prisma-idb-cli`) spawns the _built_ CLI binary rather than
  importing source, so per this repo's own 2026-06-04 history (see
  `project-prisma-next-bugs` memory) a `target-idb` or `family-idb` source
  change is invisible to it until both are rebuilt — a green `cli-tests`
  run after touching either package without rebuilding first is testing
  the old binary, not your change. This bites hardest in Phase 8.6, which
  rebuilds the CLI shell from scratch.
- `pnpm check` — typecheck via `tsc --noEmit` (through Turbo, per-package).
  **This is the one that catches what `pnpm test` (vitest/esbuild, strips
  types) cannot** — see the build-staleness note below.
- `pnpm build` — builds every package via Turbo; `pnpm --filter
@prisma-next-idb/<name> build` builds just one.
- `pnpm lint` — repo-wide lint.
- `pnpm run:ci` — the full local approximation of what CI runs
  (`format && generate && lint && check && build`); a reasonable "am I
  actually done" check before opening a phase's PR for review, though probably overkill to run after every single commit.
- `pnpm test:prisma-next-e2e` / `pnpm test:prisma-next-kanban-e2e` —
  Playwright, real-browser. Per this repo's own history (see
  `project-prisma-next-bugs` memory, the 2026-06-02 `node:crypto` entry),
  a browser-only regression (Node API used somewhere that only runs in the
  page) can pass `pnpm test` _and_ `pnpm check` and only fail here — worth
  running at least once per stack, not just at Phase 8.7.

**The build-staleness trap, concretely, for this port.** `pnpm test` does
not rebuild a package's dependencies before running its tests, and `pnpm
check`'s typecheck reads whatever `dist/*.d.mts` currently exists on disk —
neither one notices that a package it depends on has newer _source_ than
built output. This repo's own history has hit this repeatedly enough to be
documented as a named gotcha (`project-prisma-next-bugs` memory — multiple
entries, e.g. 2026-08-17: _"`target-idb`/`family-idb` changes … are
invisible to `client-idb` tests until `pnpm --filter
@prisma-next-idb/target-idb build && pnpm --filter @prisma-next-idb/family-idb
build`"_). Phase 8.1 touches every Tier 1 package in dependency order —
after changing each one, run `pnpm --filter @prisma-next-idb/<name> build`
_before_ moving to the next package or before trusting a downstream
package's `pnpm check`/`pnpm test:prisma-next` result. If something that
"should" be a type error isn't, or a value that should exist reads as
`undefined` at runtime, suspect a stale `dist/` before suspecting the port
logic — rebuild, then re-check.

### 8.5 Practical notes for this specific stack

- Keep each phase's commits scoped to that phase — a fresh agent session
  picking up e.g. Phase 8.4 shouldn't have to untangle unrelated Phase 8.3
  changes bleeding into the same branch.
- Per Phase 7's convention (`plans/README.md`), land a `PLAN_8.x_<name>.md`
  for each phase before or alongside opening that phase's PR — this
  document (`PLAN_8.0`) is the survey and phase map, not per-phase
  acceptance criteria. A fresh session starting Phase 8.4 should write
  `PLAN_8.4_runtime_core_split.md` (or find one already written by a prior
  session) rather than re-deriving §4's findings from scratch each time.
- If a phase's implementation surfaces a finding that changes an earlier
  phase's assumptions (e.g., Phase 8.4's `runExecute()` design decision
  turns out to affect Phase 8.2's migration-hash work), update _this_
  document's relevant section rather than letting the discrepancy live only
  in a later phase's PR description — this doc is the thing every
  subsequent session reads first.

## 9. Proposed phase breakdown

| Phase | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Depends on                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 8.1   | Mechanical import/package rewrite across Tier 1 per §6's table; `package.json` dependency swap, exact-pinned version (re-verify per the version-drift callout before locking it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                           |
| 8.2   | Content-hash migration-tree conversion: strip `sha256:` (codemod) across the 3 Tier-1 migration roots + the 3 root `contract.json`/`.d.ts` files, re-verify every `migrationHash`; fix `migration-hash.ts`'s prefix + add the hash-identity test against a real recorded hash. **The store-layout conversion (`migrate-migrations-layout.mjs`) does not apply to Tier 1 — see `PLAN_8.2` §0**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 8.1                                                         |
| 8.3   | Contract-layer breaks, source-level only: `extensionPacks`→`extensions` in `psl-interpreter.ts`/`contract-builder.ts`/test fixtures (3 sites), stale hardcoded error-code sweep (found + fixed 2 real hits — `family-idb/test/control.test.ts`'s `"PN-RUN-3003"`, `schema-verify.ts`'s locally-defined `VERIFY_CODE_SCHEMA_FAILURE = "PN-RUN-3010"` — both now import the framework's own constants). `sourceFormat`/`outputPath` riders confirmed absent from Tier 1's config. **Re-emitting the checked-in `contract.json`/`.d.ts` files is explicitly out of this phase's scope — see `PLAN_8.3_contract_layer.md` §0** (needs a working `contract emit`, which is Phase 8.5's job)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 8.1                                                         |
| 8.4   | **Done** — `RuntimeCore` query()/execute() split: deleted the stale `execute()` override, implemented `runExecute()` (drains `runDriver()` and counts into `{ affectedRows }`). `IdbMiddleware` needed no changes (already matched rc.4's split hook shape). Renamed `client-idb`'s own `IdbQueryExecutor` interface `execute`→`query` too — required, not optional, since `IdbRuntime` is structurally assigned into `IdbQueryExecutor`-typed slots at 2 wiring sites and its row path could no longer be named `execute` once `RuntimeCore.execute()` became the stats-returning method. Cascaded to every real call site across `client-idb`/`sync-extension-idb` (6 test-mock classes included); `driver-idb`'s unrelated `IdbTransactionScope.execute()` confirmed untouched and left alone. A follow-up in the same PR fixed a delete-undercount gap the first cut shipped with: `execDelete` (`driver-idb/src/core/execute/ops.ts`) now walks a cursor over its key/range and echoes each row it actually deletes, instead of always resolving `[]` — see `PLAN_8.4_runtime_core_split.md` §6 for the full inventory, the build-staleness gotcha hit while validating it, and why a cursor (not `get()`-then-`delete()`) was needed for correctness on ranged deletes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 8.1                                                         |
| 8.5   | **Done** — narrower than originally scoped, per empirical findings in `PLAN_8.5_cli_config_unification.md`. Confirmed the generic `prisma@rc.7` CLI's `contract emit` already works against an IDB-family config wrapped in `definePrismaConfig({ orm: … })` (no `idbCommandFamily` needed for that command) — but also confirmed **§3 item 3's "hash-inert" prediction was wrong**: re-emission moves `storageHash`/`profileHash` even for byte-identical schema content (the vendor's hash implementation changed between the frozen 0.16.0 scope and rc.4, not our contract), and every Tier-1 package except `sync-server-sql` has a _committed_ migration chain whose `end-contract.json` would go inconsistent if re-emitted before Phase 8.6 can regenerate the whole chain. So only `sync-server-sql` got the full treatment (rename + envelope + `prisma@rc.7`/`@prisma/cli-engine` devDeps + script rewiring + actual re-emission) — its own contract fixture is gitignored/regenerated per test run, so re-emitting it is safe, and doing so turned its previously dead-CLI-broken `pnpm test` green (23/23). `apps/prisma-orm-usage`, kanban's IDB-side config, and `sync-extension-idb` are deferred to Phase 8.6 (bundled with the chain-regeneration + `idbCommandFamily` work, since `family-idb`'s own bin/`resolve-cli-paths.ts` still hardcodes the old filename and is being replaced there anyway). Kanban's Postgres side is untouched for an independent reason — confirmed it's whole-tier Tier 2 (§7 decision 4: `@prisma-next/family-sql`/`migration-tools`/`postgres`/`sql-builder`/`sql-contract` all still `^0.16.0`, real importers beyond the config file), not a Phase 8.1 leftover                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 8.1, 8.3                                                    |
| 8.6   | **Done** — CLI mounting, narrower than §5 Option A originally assumed: `family-idb` already has an already-ported `ControlFamilyInstance` (built in Phase 7), so the generic `prisma` CLI already covers `contract emit`/`db init`/`update`/`verify`/`sign` for IDB configs (structured refusals for the DB-connected ones, by design). Built a `@prisma/cli-engine` shell (`idbCommandFamily`, reusing the published `ormConfigSection` rather than minting a new section) covering only the 3 commands with no generic equivalent: `migration plan`/`contract-space`/`preflight`, replacing the commander-based `bin/prisma-next-idb.ts`. Bin name unchanged. Deleted `resolve-cli-paths.ts` (superseded by `finalizeConfig`, also a published export). Also bumped every Tier-1 package's `@prisma/orm-*` pin to `8.0.0-rc.5` (confirmed new `latest`, verified safe for this specific hop via `sync-server-sql`'s real-Postgres suite). `tests/prisma-idb-cli` rewritten for the new config shape, the engine's exit-code convention (structured failure = 2, not 1), and stdout/stderr routing (`--help` → stdout; command log + errors → stderr) — 31/31, up from 9/31. See `PLAN_8.6_cli_mounting.md` for the full account, including a real sink-buffering bug the rewrite surfaced. Chain regeneration for the 3 deferred packages split out to **Phase 8.6.1** per the user's explicit decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 8.1, 8.5                                                    |
| 8.6.1 | **Done** — chain regeneration + `prisma.config.ts` rename for the 3 packages 8.6 deferred. Mid-phase scope change (user's call): since nothing depends on these packages yet, wiped each committed chain and regenerated a fresh baseline instead of bridging old hashes forward — except `apps/prisma-orm-usage`, which got a genuine two-step chain (baseline + `add_tag`) to keep its Playwright suite's real-browser multi-hop migration coverage alive. Found and fixed a real bug surfaced while validating the (later abandoned) bridge approach: `client-idb`'s `auto-migrate.ts` never advanced the marker across a zero-op migration package, so any future hash-only re-emission would strand real users' local databases forever (fixed + regression-tested, 220/220). Also found and fixed a pre-existing invalid schema: `sync-extension-idb`'s `bySynced` index keyed a Boolean field, which `family-idb`'s validators now unconditionally (and correctly) reject — dropped it; the wipe-and-rebaseline approach meant this never became a destructive migration needing a downstream consumer policy change. `apps/prisma-idb-kanban-example`'s IDB side regenerated too; its emitted `contract.d.ts` initially didn't type-check (`Contract` missing `storage` everywhere it's consumed) and was shipped as a named, deferred vendor `.d.ts`-emission defect, same treatment as 8.10 — later root-caused and fixed: kanban's `package.json` never declared `@prisma/orm-framework` directly (unlike the other 2 packages), so under pnpm's per-package dependency isolation the emitted file's own `@prisma/orm-framework/contract/types` import silently resolved to nothing and degraded to `any`, dropping `storage` from the computed type. Added the missing direct dependency; `pnpm check` for kanban is now clean apart from a pre-existing, unrelated Postgres-side (Tier 2) gap confirmed present on `main` too. See `PLAN_8.6.1_chain_regen.md` for the full account, including two more documented-not-fixed CLI gaps (`migration preflight` has no `--space` flag; an unrendered `{bin}` placeholder in one vendor error message)         | 8.6                                                         |
| 8.7   | **Done** — full validation pass, but turned out to be more than "run the commands": closed out both of 8.10's open findings (below) rather than leaving them deferred, since `family-idb`'s tests can actually execute now (post-8.4) and the deletion hypothesis PLAN_8.1 §5 warned not to assume turned out to be correct — verified by deleting both properties and getting a clean `pnpm check` plus 230/230 passing tests (29 `adapter-idb` + 201 `family-idb`) across both packages. Also fixed a `client-idb` straggler from 8.6.1 (stale migration-chain path in a test, landed on #222 instead of here) and a local-only `pnpm lint` false positive (per-package `prettier --check .` can't see the root `.prettierignore`, so a locally-built `dist/` gets flagged — doesn't affect CI, which lints before building). Ran the full validation surface for real: `pnpm build`/`check`/`lint`/`test:prisma-next` all green repo-wide except kanban's Tier 2 side (explicit carve-out, not a regression); both Playwright suites green (101/101 usage, 12/12 kanban); CLI shell manually exercised end to end against `apps/prisma-orm-usage`'s real config. See `PLAN_8.7_full_validation.md` for the full account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 8.1–8.6                                                     |
| 8.8   | Tier 2 — `apps/prisma-idb-kanban-example`'s Postgres side. **Done.** Contrary to §7 decision 4's expectation, this landed as one phase, not a survey-then-decompose split — user's call, confirmed via Q&A before starting. Stacked directly on `phase-8.7-full-validation`'s tip (deviates from this row's own "independent" note below and from §8.2's "not part of this stack" — kanban's `package.json` already mixed rc.5 `orm-framework`/`orm-toolchain` with 0.16.0 SQL-family packages on this open stack, a state that doesn't exist on `main`, so basing off `main` wasn't viable). Grep-verified the actual breaking-change surface rather than assuming the full SQL-family CHANGELOG applied: kanban's Postgres side only ever touches `defineConfig`/the runtime client factory/the migration DSL, so RLS, aggregates, and the raw-lane reshape were all confirmed not to apply. Found two real API reshapes undocumented in any of the 6 upgrade-recipe files (DDL migration methods now return promises; `foreignKey` exists as an importable constraint-builder) only by reading installed `.d.ts` files — decided against hand-porting the two committed migrations given that risk, and instead wiped + regenerated one fresh baseline via the real, live `prisma migration plan`/`db init` CLI against a real Postgres container, which also self-corrected a wrong guess (the CLI-generated file still uses `addForeignKey`'s old object-literal shape, not the `foreignKey()` helper). Validated against a real live Postgres end to end: schema applied cleanly, `pnpm check` is clean for kanban for the first time in this entire stack, full repo `pnpm check`/`build`/`lint` green, and the real Playwright suite passed 12/12 (one apparent failure under 4-worker contention reproduced as a clean pass both in isolation and on a full re-run — confirmed flake, not a regression). See `PLAN_8.8_postgres_port.md` for the full account                                                                                                                                                                                                  | 8.1–8.7 (stacked, not independent — see note)               |
| 8.9   | Content-addressed contract-snapshot store adoption (ADR 240). **Done.** Landed the moment the "no functional payoff today" premise stopped holding: Phase 8.8 wired kanban's Postgres side to the real, live `@prisma/orm-postgres` CLI, whose own scaffolder already writes the ADR 240 store — leaving the IDB side as the only migration layout still on the pre-ADR-240 sibling-copy shape. Grep-verified the whole touch surface is `family-idb/src/core/migration-plan.ts` (writer+reader) plus 2 test files — found IDB's rendered `migration.ts` never imports the contract at all (unlike vendor Postgres's typed `Migration<Start, End>`), so `end-contract.*` was pure planning-time bookkeeping, making this a storage-format swap in code we own, not a renderer rewrite. Rewrote `writeMigrationPackage`/`planIncremental` to write/read `migrations/snapshots/<hash>/contract.{json,d.ts}`; the old head-consistency check (comparing a re-read `storageHash` against `migration.json`'s `to`) collapsed rather than relocated, since the store's address _is_ the hash; added the ADR's reserved-space-id guard (`spaceId !== "snapshots"`) and a real bug fix the directory-scan filter needed (an extension space's `targetDir` is `migrationsDir` itself, so the store sits as a sibling of migration packages and was getting mistaken for one — `sync-extension-idb` hits this for real, not hypothetically). Regenerated all 3 committed IDB chains via the real `prisma-next-idb migration plan` CLI; confirmed every `storageHash` and `ops.json` byte-content reproduced exactly against the pre-wipe committed chain (`migrationHash` alone moves on every regen regardless of layout, since it hashes `createdAt` — corrected a wrong assumption in the phase's own validation plan, not a regression). `preflight.ts`'s deferred schema-verification TODO stays explicitly deferred (PLAN_8.0 said "becomes tractable," not "becomes required"). Full repo `pnpm check`/`build`/`lint`/`test:prisma-next` green; both Playwright suites green (101/101 usage, 12/12 kanban). See `PLAN_8.9_contract_snapshot_store.md` for the full account | 8.1–8.8 (stacked on 8.8's tip, same linear-stack precedent) |
| 8.10  | PSL scalar-authoring unification (`vendor/prisma` commit `72cd71550f`, TML-2986, "unify PSL scalar types and add native scalar constructors", #1022). **Closed by 8.7, entry kept for history.** Originally discovered by Phase 8.1 (§2 findings 2/3 of `PLAN_8.1_mechanical_import_rewrite.md`) and thought to need vendor-source archaeology into how targets now register scalar-to-codec mappings. Turned out both `AdapterDescriptor.scalarTypeDescriptors` and `BuildSymbolTableOptions.scalarTypes` were simply vestigial post-#1022 — deleting them (not replacing them with something else) is the fix, confirmed by a clean typecheck plus the full runtime test suite staying green. No archaeology needed; see `PLAN_8.7_full_validation.md` §1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 8.1; closed                                                 |

## 10. Sources

- `vendor/prisma/CHANGELOG.md` (full read, `v0.12.0` → `v8.0.0-rc.2`)
- `vendor/prisma/docs/releases/v8.0.0-rc.{3,4}.md` (not yet folded into
  CHANGELOG.md at time of writing)
- `vendor/prisma/skills/prisma-next-upgrade/upgrades/{0.16-to-0.17,
0.17-to-8.0.0-rc.1, 8.0.0-rc.1-to-8.0.0-rc.2}/instructions.md`
- `vendor/prisma/skills/prisma-8-extension-upgrade/upgrades/{0.16-to-0.17,
8.0.0-rc.1-to-8.0.0-rc.2}/instructions.md`
- `vendor/prisma/packages/9-public/@prisma/{orm-framework,orm-toolchain,
orm-postgres}/package.json` (exports maps, read directly)
- `vendor/prisma/packages/1-framework/1-core/framework-components/src/
execution/{runtime-core.ts,runtime-middleware.ts}` (read directly against
  our `runtime-idb` subclass)
- `vendor/prisma/docs/architecture docs/subsystems/11. CLI.md`,
  `vendor/prisma/docs/architecture docs/adrs/ADR 211 - prisma-next bin-only
distribution.md` (CLI mounting architecture, §5)
- `npm pack @prisma/cli-engine@0.2.0` and `npm pack
@prisma/orm-toolchain@8.0.0-rc.4`, both unpacked and read directly
  (`dist/index.d.ts`, `dist/report-BpE5F1IH.d.ts`, `dist/cli.d.mts`) —
  confirms `createCli`/`defineCommandFamily`/`defineCommand`/
  `ormCommandFamily` are real public exports, §5
- `npm view prisma@next version` / `dependencies`, `npm view
@prisma/cli-engine versions --json`, `npm view
@prisma/{orm-framework,orm-toolchain,orm-postgres} dist-tags --json` —
  registry checks that separated the `prisma` CLI's own version counter
  (`8.0.0-rc.7`, from `prisma/prisma-cli`) from the ORM packages' (genuinely
  `8.0.0-rc.4`, `latest` on all three), motivating the "two independent
  version counters" callout at the top of this document
- Our own source: full `@prisma-next/*` import inventory via grep across
  `packages/prisma-orm/*/src`; `packages/prisma-orm/client-idb/src/core/
migration-hash.ts`; `packages/prisma-orm/runtime-idb/src/idb-runtime.ts`;
  `apps/*/package.json`, `apps/*/prisma-next.config.ts`,
  `apps/*/migrations*/`
- GitHub stacked-PR docs (§8): [Quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart),
  [CLI command reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands),
  [Managing stacked PRs](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests),
  [public preview changelog post](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
- [[project-prisma-next-upstream-drift]] memory (2026-08-18 survey, now
  superseded by this document for anything version-specific)
