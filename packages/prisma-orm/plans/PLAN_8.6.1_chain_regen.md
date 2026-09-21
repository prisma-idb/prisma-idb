# Phase 8.6.1 — Chain regeneration (`prisma.config.ts` rename + fresh migration chains)

Stack layer: `feat/prisma-8` → ... → `phase-8.6-cli-mounting` → `phase-8.6.1-chain-regen`. Depends on 8.6 (needs the `prisma-next-idb` shell it built).

Split out of Phase 8.6 per the user's explicit decision: CLI mounting was
plumbing risk, chain regeneration is migration-content risk, and the two
shouldn't land in the same PR. This phase does the deferred work for the 3
packages 8.6 left alone: `apps/prisma-orm-usage`, `packages/prisma-orm/sync-extension-idb`,
and `apps/prisma-idb-kanban-example`'s IDB side.

## 0. Scope decision made mid-phase: wipe and re-baseline, not bridge

The original plan (written before implementation started) was to preserve
every package's committed migration history via a zero-op "bridge" migration
per package — re-emit the contract under rc.5, diff it against the committed
one, and if the diff is hash-only, land a migration package with `ops: []`
carrying the chain from the old hash to the new one. This is what Phase
8.5 §0's finding actually asked for, and it's fully CLI-supported: `migration
plan` happily generates a zero-op package when the diff is empty (verified
empirically in a scratch project before touching any real package).

**The user overrode this once work was underway**: since nothing external
depends on these 3 packages yet (all genuinely new, no real consumers), the
simpler, honest move is to delete each package's existing migration chain
outright and regenerate a single fresh baseline from the current contract.
No bridge migrations, no historical hash archaeology. This is not a "give up
on rigor" shortcut — it removed an entire class of downstream risk (see §1
below, which the bridge approach would have walked straight into) and is the
right call for pre-1.0 packages with no committed consumers.

**One exception**: `apps/prisma-orm-usage` still gets a genuine two-step
chain (baseline, then `add_tag`), not a single collapsed baseline — see §3.
That's not history-preservation for its own sake; it's because the app's own
Playwright suite (`tests/migration.spec.ts`) is the only real-browser test of
multi-hop chain walking with data preservation, and it directly exercises
`auto-migrate.ts` — the file §1 below required editing. Collapsing to one
baseline would have silently deleted the one test that guards that exact
code path.

## 1. A real bug the bridge-migration path would have shipped silently: `auto-migrate.ts` never advanced the marker across a zero-op package

Found (and fixed, and tested) before the "wipe and re-baseline" decision was
made, while validating the originally-planned bridge approach — kept in this
phase regardless of the scope change, because it's a genuine, independently
verified defect that will resurface the next time a real hash-only
re-emission happens (the next rc bump, if the vendor's hashing algorithm
moves again, is exactly this scenario).

`client-idb/src/core/auto-migrate.ts`'s `autoMigrate()` only added a space to
`pendingPerSpace` (the set that gets applied via `openAndUpgrade` and has its
marker written) when `walkChain(...)` returned at least one op:

```ts
if (pendingOps.length > 0) {
  pendingPerSpace.push({ spaceId: space.spaceId, ops: pendingOps, storageHash: targetHash });
}
```

A migration package with `ops: []` — exactly what `migration plan` generates
for a hash-only, no-structural-change re-emission — walks the chain fine but
contributes zero ops, so the space never gets pushed, `openAndUpgrade` never
runs for it, and the marker in `_prisma_next_marker` never advances past the
old hash. Every subsequent app load repeats the same walk, gets the same
zero ops, and never converges — a real user's local database would be stuck
re-attempting the same no-op "migration" forever, with `verifyMarker()`
returning `false` indefinitely.

Reproduced empirically first (`buildContractSpaceFixture([v1, v1Rehashed])`
where `v1Rehashed` is `v1` with only `storage.storageHash` changed — the
bridge package has 0 ops, confirmed via `.migrations[1].ops.length === 0`),
then fixed: push into `pendingPerSpace` whenever the marker differs from the
target hash, regardless of `ops.length` — `openAndUpgrade` already handles
an empty `ops` array correctly (version bump + marker write, no DDL, already
relied on elsewhere for the "nothing pending" no-op case). Permanent
regression test added: `client-idb/test/auto-migrate-evolution.test.ts` →
`"advances the marker across a zero-op bridge migration (hash-only contract
re-emission)"`. Full suite still 220/220 (219 + 1 new) after the fix,
including the pre-existing "repeated open is a no-op, no version bump" tests
— the fix doesn't affect the already-converged case.

This bug is orthogonal to the wipe-and-rebaseline decision — it's a real
defect in shipped code, independently useful, and stays fixed regardless of
which regeneration strategy this phase ended up using.

## 2. A real, pre-existing schema defect the port surfaced: `sync-extension-idb`'s `bySynced` index

`OutboxEvent.bySynced` indexed the `synced: Boolean` field. IndexedDB cannot
use a boolean as an index key (still an open spec proposal —
https://github.com/w3c/IndexedDB/issues/76): a range query against it throws
`DataError`, and records are silently omitted from the index on write.
`family-idb`'s `defineContract`/PSL validators reject this **unconditionally,
with no escape hatch** (`contract-builder.ts` / `psl-interpreter.ts` — every
index's key-path codec must satisfy `isValidIdbKeyCodec`).

This isn't a new regression from this phase — `outbox-store.ts` already
documented the index as dead weight ("removing it is a schema change
requiring a migration") and already worked around it with an in-memory
`.filter()` scan instead of querying the index. The index was simply never
exercised through a working `contract emit` before now: the committed
`contract.json` predates this port entirely (last touched for the
Phase 8.2 sha256-prefix strip, never actually regenerated), and the CLI that
would have caught this was dead against rc.4+-shaped config until Phase
8.5/8.6 built a working one.

Fixed by removing the index from `src/contract.ts` (the in-memory scan in
`getNextBatch` was already the real query path — nothing else referenced
`bySynced`). Since this phase wipes and re-baselines the whole chain (§0),
the fresh baseline simply never creates the invalid index — this **never
becomes a destructive migration** a downstream consumer would need to
explicitly allow. Had this landed via the originally-planned bridge-migration
approach instead, dropping the index mid-chain would have been a
`dropIndex` op (classified `destructive` — confirmed in
`target-idb/src/core/migration-factories.ts`), which would have made every
consumer's `createAutoMigratingIdbClient()` call throw under the default
safe policy (`onDestructive: 'refuse'`) unless they explicitly opted in. The
wipe-and-rebaseline decision defused this before it became a cross-package
consumer-policy problem — worth naming explicitly since it's easy to miss
in the diff.

## 3. What actually shipped, per package

All 3 packages: `prisma-next.config.ts` deleted, replaced by `prisma.config.ts`
wrapped in `definePrismaConfig({ orm: ormConfig({...}) })` (`definePrismaConfig`
from `@prisma/cli-engine`, `ormConfig` = `@prisma-next-idb/family-idb/config-types`'s
`defineConfig`, aliased — mirrors `sync-server-sql`'s Phase 8.5 pattern
exactly). `prisma: 8.0.0-rc.7` added as a devDependency (bundles
`orm-toolchain@rc.4` internally per Phase 8.5's finding — already established
safe for `contract emit`/`db init` against rc.5-typed config).

- **`apps/prisma-orm-usage`**: had no `contract:emit` script at all before
  this phase (added one: `prisma contract emit --config prisma.config.ts`).
  `prisma-next: ^0.16.0` devDependency removed (nothing else used it).
  Migrations wiped and regenerated as a genuine two-step chain (baseline,
  then `add_tag`) — see §0's exception. Reconstructed by temporarily
  removing the `Tag` model (+ `Post.tags` relation) from
  `contract.server.ts`, emitting, planning the baseline (7 ops — marker,
  users×3, posts×2, random_store), restoring the full contract, emitting
  again, planning `--name add_tag` (2 ops — tags store + `byPostId` index).
  7 + 2 = 9, matching the op count from an earlier throwaway single-baseline
  attempt exactly — confirms the split is a faithful decomposition, not a
  different shape. `tests/migration.spec.ts`'s hardcoded `V1_STORAGE_HASH`
  updated to the new baseline's hash; its hand-seeded raw-IDB store list
  (marker, posts+byAuthorId, random_store, users+byEmail+byScore) was
  verified against the new baseline's `ops.json` line by line — still an
  exact match.
- **`packages/prisma-orm/sync-extension-idb`**: `contract:emit` script
  rewired from `prisma-next contract emit` to `prisma contract emit --config
prisma.config.ts`; `prisma-next: ^0.16.0` devDependency removed. `bySynced`
  index dropped (§2). Migrations wiped, single fresh baseline regenerated
  (this is an extension space — `--space idb-sync`, migrations live directly
  under `migrations/`, not `migrations/app/`). `src/exports/control.ts`'s
  hardcoded `dirName`/import paths updated to the new baseline package
  (`migrations/refs/head.json` is JSON-imported and picks up the new hash
  automatically; the dirname-keyed imports needed a manual edit — the CLI's
  own log output says as much). `test/helpers.ts`'s raw-IDB `OUTBOX_STORE`
  fixture spec had its own `bySynced` index declaration removed to match.
- **`apps/prisma-idb-kanban-example`** (IDB side only): `contract:emit`
  script rewired the same way. **Not touched**: `prisma-next.config.postgres.ts`
  and every Postgres-side script/dependency (`contract:emit:postgres`,
  `migration:postgres:*`, `db:*`, all `@prisma-next/*@^0.16.0` deps) — Tier 2,
  independently scoped, still frozen, per Phase 8.5's explicit decision.
  `prisma-next: ^0.16.0` **stays** as a devDependency (still load-bearing for
  the Postgres-side scripts) — `prisma: 8.0.0-rc.7` was added **alongside**
  it, not as a replacement. Don't "clean up" the old pin later without
  re-checking the Postgres side is actually ready to move. `@prisma/orm-toolchain`
  was also missing as a **direct** dependency (only reachable transitively
  through `family-idb` etc.) — `contract-space.generated.ts` imports
  `contractSpaceFromJson` from it directly, so `pnpm check` failed with
  "cannot find module" until it was added explicitly (mirrors
  `apps/prisma-orm-usage`'s existing direct dependency on the same
  package). Migrations wiped, single fresh baseline regenerated.

Every fresh emission's `contract emit` was run through the real, generic
`prisma@8.0.0-rc.7` binary (`pnpm --filter <pkg> exec prisma contract emit
--config prisma.config.ts`) — confirming Phase 8.5's finding still holds
for all 3 packages, including the PSL-sourced kanban contract (§4 covers
the one real gap that emission surfaced there).

Every generated/regenerated file (`contract.json`, `contract.d.ts`,
`contract-space.generated.ts`, every migration package's `migration.json`/
`ops.json`/`migration.ts`/`end-contract.{json,d.ts}`) was run through
`prettier --write` after generation — the CLI's raw `JSON.stringify(...,
null, 2)` output doesn't exactly match Prettier's JSON formatting, and
these files aren't `.prettierignore`d (unlike `dist/`), so `pnpm lint`
would otherwise flag every one of them.

## 4. Resolved: kanban's regenerated `contract.d.ts` didn't type-check — missing direct dependency, not a vendor defect

**Update: root-caused and fixed after the initial writeup below shipped this
as a known-issue.** The actual cause was mundane: kanban's `package.json`
never declared `@prisma/orm-framework` as a direct dependency — only
`@prisma/orm-toolchain` (added earlier in this same phase, see §3, for an
unrelated "cannot find module" error at runtime). Both `apps/prisma-orm-usage`
and `sync-extension-idb` _do_ declare `@prisma/orm-framework` directly.

Under pnpm's isolated `node_modules`, a package only resolves bare
specifiers to dependencies it (transitively) declares itself — not to
whatever a sibling workspace package happens to depend on, even in the same
monorepo. `contract.d.ts` is emitted directly into kanban's own `src/`, not
into a library package with its own resolvable dependency tree, so its
`import type { Contract as ContractType, ... } from "@prisma/orm-framework/contract/types"`
had nothing to resolve against and silently degraded to `any` (no `TS2307`
surfaced because the failure happens inside a type-only import consumed by
other type positions, not a runtime import). Once `ContractType` is `any`,
`Omit<ContractType<{...}>, "roots" | "domain">` — the piece that's supposed
to contribute the `storage` property — collapses to `any` too, and the
surrounding intersection type never gets a `storage` key. Hence: "Property
'`storage`' is missing in type '`Contract`'."

**Fix:** added `"@prisma/orm-framework": "8.0.0-rc.5"` to kanban's
`dependencies`, alongside the existing `orm-toolchain` entry, then
`pnpm install`. `pnpm check` for kanban now reports exactly the two
pre-existing, out-of-scope Postgres-side (Tier 2) errors in `sync.ts`
("Property 'extensions' is missing" against the _old_, frozen
`@prisma-next/contract@0.16.0` type) — confirmed present identically on
`main` (same locked dependency hash, same untouched generated file), so
unrelated to this phase.

**Why the original investigation didn't find this:** the three ruled-out
hypotheses below were reasonable but the comparison baseline was wrong. The
"not a plain module-resolution failure" check _did_ reproduce a genuine
"Cannot find module" for the exact same specifier — that was the actual
signal — but it was dismissed because `apps/prisma-orm-usage`'s emitted
`.d.ts` "uses the identical import specifier and type-checks completely
cleanly." That comparison never checked _why_ usage resolved fine: its
`package.json` already had `orm-framework` as a direct dependency, kanban's
didn't. Same specifier, same monorepo, different declared dependencies —
enough to change the outcome under pnpm's per-package isolation.

The original ruled-out list is kept below for the record; the first two
findings still stand (neither was ever the cause), only the third's
conclusion was wrong:

- **Not the `@internal/contract/types` vs `@prisma/orm-framework/contract/types`
  import path.** The very first emission genuinely wrote `@internal/contract/types`
  (a private, unpublished package — confirmed absent from `node_modules`
  entirely). Hand-editing that one import line to the public
  `@prisma/orm-framework/contract/types` (which re-exports the identical
  `Contract` interface, confirmed by reading `contract-types-*.d.mts`
  directly) made zero difference — same 8 errors, same lines. A **second**,
  independent fresh emission (after `pnpm install` picked up new direct
  dependencies for other reasons — see §3's kanban note) spontaneously
  emitted the public path from the start, with **no change in outcome**.
  Whatever nondeterminism causes the import specifier to vary between runs,
  it isn't the cause of the missing `storage` property.
- **Not the `execution`/`mutations.defaults` block's complexity.** Kanban's
  contract has one (from `@default`/`@updatedAt` schema annotations); the
  other two packages' don't. Stubbing kanban's emitted `execution` field to
  `any` (eliminating its ~40-line literal type) made zero difference.
- ~~**Not a plain module-resolution failure degrading to `any` under
  `skipLibCheck`.**~~ **This was actually it.** The minimal reproduction did
  fail with "Cannot find module" for `@prisma/orm-framework/contract/types" —
correctly. The mistake was concluding it wasn't the discriminator because
`apps/prisma-orm-usage`resolved the same specifier cleanly, without
checking that usage's`package.json`declares`@prisma/orm-framework`
  directly and kanban's didn't.

## 5. Two more known, pre-existing gaps surfaced but not fixed here

- **`migration preflight` has no `--space` flag.** Confirmed via `--help` and
  by trying it: `migration preflight --space idb-sync` → `[CLI.INVALID_ARGUMENTS]
No flag registered for --space`. The command hardcodes `<migrationsDir>/app/`
  (per its own `--help` text). `sync-extension-idb`'s regenerated chain has
  no CLI-level preflight path as a result — its own test suite (56/56,
  exercising `createAutoMigratingSyncIdbClient` against the real migration
  package data) is the substitute validation, same as before this phase.
  Pre-existing gap (there was never a `migration:preflight` script for
  `sync-extension-idb` either), not a regression.
- **The `{bin}` placeholder leaks unrendered in one error message.** Running
  any `prisma-next-idb` command with zero config at all produces (among
  other errors) `Create a config file: {bin} orm init` — a literal,
  un-interpolated `{bin}` token. Traced to `@prisma/orm-toolchain/dist/cli.mjs`'s
  own `CONFIG.FILE_NOT_FOUND` diagnostic (`command: "{bin} orm init"`,
  confirmed by grepping the installed dist directly). `@prisma/cli-engine`
  does have real `{bin}` substitution machinery (`engine-*.js`'s
  `formatExample`), but it's only wired up for command-family `redirects`'
  example strings, not for every structured error's `fix`/`command` field —
  this diagnostic falls outside that path. Also, even correctly
  interpolated, the advice (`orm init`) names a command our shell doesn't
  mount at all (`prisma-next-idb` only mounts `migration plan`/`contract-space`/
  `preflight` — `orm init` lives on the generic `prisma` CLI). Not fixed:
  `ormConfigSection` is reused as-is by design (Phase 8.6 §0.2 — "reused as
  a real, published export, not re-implemented"), so patching this means
  either forking vendor's diagnostic text (contradicts that design decision)
  or accepting a wrong-in-general fix for one bin name. Reported as a vendor
  UX gap, not actioned.

## 6. Validation

- `pnpm --filter @prisma-next-idb/client-idb test` — 220/220 (219 baseline +
  1 new regression test for §1's fix).
- `pnpm --filter @prisma-next-idb/client-idb check` — clean.
- `pnpm --filter @prisma-next-idb/sync-extension-idb test` — 56/56.
- `pnpm --filter @prisma-next-idb/sync-extension-idb check` — clean.
- `pnpm --filter @prisma-next-idb/sync-extension-idb lint` — clean (after
  `pnpm format` on the freshly generated migration/contract files — see §3).
- `pnpm --filter @prisma-next-idb/cli-tests test` — 31/31, unchanged from
  Phase 8.6 (rebuilt `family-idb`/`target-idb` first — build-staleness trap).
- `apps/prisma-orm-usage`: `pnpm check` clean; `pnpm test` (Playwright,
  real Chromium) — **101/101**, including the reconstructed two-step
  `migration.spec.ts` (the one test that actually exercises §1's fix against
  a real browser IndexedDB, not just the `client-idb` unit-test fixture).
- `apps/prisma-idb-kanban-example`: `pnpm check` — after §4's fix
  (`@prisma/orm-framework` added as a direct dependency), the IDB-side
  errors are gone; the only 2 remaining errors are the pre-existing,
  out-of-scope Postgres-side (Tier 2) `sync.ts` gap against the frozen
  `@prisma-next/contract@0.16.0` type, confirmed present identically on
  `main` (same locked dependency, same untouched generated file) —
  unrelated to this phase. `pnpm test` (Playwright) — 11/12 in the full
  parallel run; the one failure (`sync-cross-device.spec.ts`'s "board
  rename... sync to another device") passes cleanly in isolation with
  `--retries=2`, confirming a pre-existing timing flake under parallel
  workers, not a regression from this phase's changes (nothing in the diff
  touches sync timing or cross-device push/pull logic). No Postgres/docker
  was set up for this run — the IDB-side paths under test don't need it,
  and CI's own kanban e2e job is gated on the same `paths-changed` filter as
  before, unaffected by this phase.
- Manually exercised the built `prisma-next-idb` CLI directly against a
  scratch project (not just through package scripts) — `--help` tree at
  every level, `--format human` vs default JSON (confirmed the engine's
  non-TTY JSON default and envelope shape), greenfield and incremental
  `migration plan`, `--name`-required failure (exit 2), broken-chain
  failure (exit 2, `UNEXPECTED_ERROR` with a clear orphan-package message),
  missing-config failure (surfaced §5's `{bin}` finding) — ahead of and
  independent from touching any real package, to confirm Phase 8.6's shell
  genuinely holds up from a user's seat, not just its own test suite.
