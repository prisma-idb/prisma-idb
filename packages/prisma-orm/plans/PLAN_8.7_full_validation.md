# Phase 8.7 — Full validation pass

Stack layer: `feat/prisma-8` → ... → `phase-8.6.1-chain-regen` → `phase-8.7-full-validation`. Depends on 8.1–8.6.1.

PLAN_8.0 §9 scoped this phase as "run `pnpm check` + `pnpm lint` +
`pnpm test:prisma-next` green; run the two Playwright suites; exercise the
CLI shell end to end manually." In practice this wasn't just a validation
run — it's the phase where the stack actually goes green. Every PR from 8.1
through 8.6.1 shipped with `pnpm check` red on two findings PLAN_8.1 §2
flagged and explicitly left open ("not fixed", "needs its own
investigation"). This phase closes both out, fixes one straggler
regression from 8.6.1, and fixes a local-only lint false-positive — then
runs the full validation surface for real.

## 1. Closing PLAN_8.1's two open findings (the actual core content of this phase)

Both were traced to the same upstream change: `vendor/prisma` commit
`72cd71550f` ("unify PSL scalar types and add native scalar constructors",
#1022), which moved scalar-type handling into the framework's internal
"unified authoring channel" and dropped two fields that used to be supplied
by callers:

- `AdapterDescriptor.scalarTypeDescriptors` (removed) — `adapter-idb`'s
  `descriptor-meta.ts` still passed a `Map<PSL scalar name, codec id>` here.
- `BuildSymbolTableOptions.scalarTypes` (removed) — `family-idb`'s
  `psl-provider.ts` (plus two test fixtures) still passed
  `Object.keys(SCALAR_TO_CODEC_ID)` here.

PLAN_8.1 §2 recorded both as genuinely open, explicitly warning "don't
assume delete the field is correct without confirming where (or whether)
the PSL-scalar → codec mapping now lives" — written when `family-idb`'s
tests couldn't even execute yet (pre-8.4, everything threw
`this.runExecute is not a function` at runtime). That's no longer true: 8.4
landed the `RuntimeCore` split, so by this phase every test in both
packages actually runs.

That changed the evidence available, so the deletion hypothesis was tested
directly rather than deferred again: delete both properties, then run
`pnpm check` and the full test suite for both packages.

- `pnpm check` — clean on both `adapter-idb` and `family-idb`.
- `adapter-idb` tests — 29/29 passing (`filter-expr.test.ts`,
  `adapter.test.ts`).
- `family-idb` tests — 201/201 passing across all 10 suites, including
  `contract-psl.test.ts` (79 tests exercising `interpretPslDocumentToIdbContract`
  directly, i.e. real codec-id resolution per scalar type) and
  `smoke-workflow.test.ts` (the full plan → contract-space → preflight
  pipeline against two schema versions).

`SCALAR_TO_CODEC_ID` — the map `family-idb`'s interpreter actually uses at
runtime to resolve PSL scalar names to codec IDs (`psl-interpreter.ts`,
used in `contract-builder.ts` too) — is untouched. Only the vestigial copy
handed into `buildSymbolTable()`/the adapter descriptor is gone. This
confirms both were dead properties left over from before the framework
internalized scalar handling, not a mapping that needed to move somewhere
else — no vendor-source archaeology into the Postgres target's authoring
registration was needed after all.

## 2. Straggler regression from 8.6.1: `client-idb`'s stale migration path

`client-idb/test/migration-hash.test.ts` imports a real `migration.json`/
`ops.json` pair from `sync-extension-idb`'s migration chain to cross-check
the browser-safe hash implementation against the Node-side one. 8.6.1
wiped and re-baselined that chain (`20260802T0712_install_sync_extension`
→ `20260823T0553_baseline`), but `client-idb` wasn't in 8.6.1's own test
scope, so the hardcoded path silently broke. **Landed directly on the
still-open `phase-8.6.1-chain-regen` (#222), not here** — that phase's
re-baseline is what broke it, and #222 was still open when this was found,
so keeping the layer that introduced the break self-consistent took
priority over merging a PR that knowingly leaves a sibling package's test
red.

Worth flagging for whoever next touches a migration chain: this test
hard-codes another package's migration directory name by import path, and
will re-break on every future re-baseline of `sync-extension-idb`. Not
hardened in this phase — the user's call was to fix the immediate break,
not add resilience against a scenario (another wipe-and-rebaseline) that's
supposed to be rare post-1.0.

## 3. `pnpm lint`'s repo-wide red: real, but not what it looked like

Every package with a `lint` script (`prettier --check . && eslint .`)
showed formatting failures — 22 files in `family-idb`, 9 in `client-idb`, 6
in `sync-extension-idb`, plus `kanban-example`'s `playwright-report/index.html`.
All of it was `dist/`/`playwright-report`/`test-results` build output, not
source drift.

Root cause: each package's `lint` script runs `prettier --check .` with
cwd inside that package. Prettier only reads a `.prettierignore` from its
own cwd — it does not search ancestor directories — so the root
`.prettierignore` (which does exclude `dist`, `playwright-report`, etc.)
never applies to a per-package invocation. Once a package is locally
built, its own `dist/` sits inside the glob `prettier --check .` walks and
gets flagged.

**Does not affect CI.** The `lint` job in `.github/workflows/build.yml`
checks out fresh and runs before any build step (`run:ci`'s own
`format && generate && lint && check && build` ordering matches this), so
`dist/` never exists on disk when CI's `pnpm lint` runs. This is a
local-dev-only papercut: a contributor who builds locally before linting
locally hits false positives CI never sees. Real source formatting was
already 100% clean once the noise is excluded — confirmed by running
`prettier --check .` by hand in each flagged package and reading past the
`dist/*` lines.

**Fixed anyway** (per explicit scope confirmation — CI-clean isn't the
same as "8.7's literal `pnpm lint` criterion holds locally too"): added a
one-line `.prettierignore` (`dist`, plus `playwright-report`/`test-results`
for `kanban-example`) to each of the 10 packages that have a `lint`
script. `apps/prisma-orm-usage` has no `lint` script of its own (not part
of `pnpm lint`'s turbo scope), so it needed nothing.

## 4. Tier 2 carve-out (explicit, not implicit)

`apps/prisma-idb-kanban-example`'s Postgres side is Phase 8.8,
deferred and unscheduled per PLAN_8.0 §7 decision 4 — full SQL-family
breaking-change surface, needs its own scoped survey. It was never in
scope for 8.1–8.7 and isn't touched here. Concretely, this means:

- `pnpm check` for `kanban-example` **stays red** —
  `src/lib/server/sync.ts`'s `ServerContract` (sourced from
  `schema.postgres.generated.d.ts`, itself importing the old, frozen
  `@prisma-next/contract/types`, not `@prisma/orm-framework`) is missing
  `extensions`, a structural gap in the old Tier-2 contract shape that
  predates this entire port and is identical on `main`.
- Everything else in `pnpm check` is green: all of Tier 1
  (`adapter-idb`, `client-idb`, `driver-idb`, `family-idb`, `runtime-idb`,
  `sync-server`, `sync-server-sql`, `sync-extension-idb`, `target-idb`),
  `apps/prisma-orm-usage`, and `kanban-example`'s own IDB side
  (`contract.d.ts`, `contract-space.generated.ts` — the thing 8.6.1 fixed).

State this explicitly rather than letting a reviewer wonder why
`kanban-example` shows red in a "full validation" phase: **it's expected,
named, and out of scope**, not a regression from this stack.

## 5. Full validation results

Ran from a clean `pnpm build` on this phase's branch tip:

- **`pnpm build`** — green (all Tier 1 + both apps).
- **`pnpm check`** — green except the named Tier 2 gap in §4. Confirmed by
  running the full repo-wide `pnpm check`, not just the Tier 1 filter.
- **`pnpm lint`** — green across all 10 packages with a `lint` script
  (Tier 1 + `kanban-example`), including real prettier + eslint, not just
  the `dist/`-noise packages from §3.
- **`pnpm test:prisma-next`** — 18/18 tasks green (builds + tests across
  all 10 filtered packages, including `cli-tests` 31/31 and
  `sync-server-sql`'s real-CLI-spawning suite).
- **`pnpm test:prisma-next-e2e`** (Playwright, `apps/prisma-orm-usage`,
  real Chromium) — 101/101 passing. Covers model queries, nested writes,
  operators, and the smoke suite.
- **`pnpm test:prisma-next-kanban-e2e`** (Playwright, `apps/prisma-idb-kanban-example`,
  real Chromium) — 12/12 passing. Covers login, kanban CRUD + PWA
  offline reload, theme persistence, cross-device sync (including
  cascade-delete-across-devices and concurrent-update conflict
  resolution), and multi-tab `SyncWorker` racing.
- **CLI shell, exercised manually** (not just via `cli-tests`) against
  `apps/prisma-orm-usage`'s real `prisma.config.ts`:
  `prisma contract emit` → `prisma-next-idb migration contract-space` →
  `prisma-next-idb migration preflight`, all three returning `ok: true`
  envelopes; `migration plan` without `--name` on an existing chain
  correctly refused with `IDB-CLI.MIGRATION_NAME_REQUIRED` rather than
  silently doing the wrong thing. (Regenerated contract artifacts from
  this manual run were discarded — pure reformatting noise against the
  committed files, not a semantic diff, and unrelated to this phase's
  actual scope.)

**Bottom line: the entire 8.1–8.7 stack is green**, with exactly one named,
pre-existing, out-of-scope exception (kanban's Tier 2 Postgres side, §4),
carried forward to Phase 8.8 whenever that gets scoped.

## 6. What a fresh session picking up 8.8 needs to know

- Don't re-derive the two #1022 findings — they're closed, not deferred.
  `SCALAR_TO_CODEC_ID` in `family-idb/src/core/psl-interpreter.ts` is the
  one real scalar-mapping source of truth; nothing else needs it fed in
  from outside.
- Tier 2 (`kanban-example`'s Postgres side) is still fully unscoped — 8.8
  needs its own survey (PLAN_8.0 §7 decision 4), not a quick patch of
  `sync.ts`'s `ServerContract` type. The `extensions`-missing error is a
  symptom of the whole `@prisma-next/contract` Tier-2 lineage being
  frozen at rc-independent 0.16.0, not a one-field fix.
- The `client-idb` migration-hash test (§2) hard-codes a sibling package's
  migration directory name. If `sync-extension-idb`'s chain gets
  re-baselined again, check that test first.
