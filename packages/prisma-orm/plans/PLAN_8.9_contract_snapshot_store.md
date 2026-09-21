# Phase 8.9 — Content-addressed contract-snapshot store (ADR 240)

Stack layer: `phase-8.9-contract-snapshot-store`, based on
`phase-8.8-postgres-port`'s tip (`29cd3b1c`). Not a strict dependency —
`PLAN_8.0` §9 lists 8.9 as depending only on 8.2 (bare-hex hashes) and
independent of 8.3–8.8 — but the same linear-stack precedent 8.8 already
set (user's call there) applies again: one open stack, phases as layers.

## 0. Why now, not "no functional payoff today"

`PLAN_8.0` §9 deferred this with "no functional payoff today — our
hash-only `migration.ts` never needed the typed-import rewiring ADR 240's
Postgres example shows." That's still true for the render surface. What
changed: Phase 8.8 wired kanban's Postgres side to the real, live
`@prisma/orm-postgres` CLI, and that CLI's own scaffolder already writes
`migrations-postgres/snapshots/<hash>/contract.{json,d.ts}` — because
that's what ADR 240 actually specifies upstream. Meanwhile every IDB
migration chain in this repo (`family-idb`'s own `migration-plan.ts`,
which we own and hand-roll) still writes per-package `end-contract.json`/
`end-contract.d.ts` siblings — the exact pre-ADR-240 shape the ADR's own
"why a store, not sibling copies" section describes. The repo now carries
two divergent migration-package layouts for no reason other than "we
hadn't ported this yet." This phase converges them.

## 1. Grep-verified touch surface

Only two production files reference `end-contract`/`start-contract`
anywhere in the repo:

- `family-idb/src/core/migration-plan.ts` — writes `end-contract.json`/
  `.d.ts` into each package dir (`writeMigrationPackage`); reads the head
  package's `end-contract.json` back in `planIncremental` to diff the next
  contract against.
- `family-idb/src/core/preflight.ts` — **comment only**, references
  "the head's `end-contract.json`" describing a still-deferred
  `verifySchema` TODO. No code in this file actually opens the file.

No other package (`client-idb`, `target-idb`, `adapter-idb`,
`sync-extension-idb`, `contract-space-codegen.ts`, the browser runtime)
touches these files at all — the browser side consumes `ops.json`/
`migration.json` via `contractSpaceFromJson`, never the sibling contract
copies. Two test files assert the current shape:
`family-idb/test/migration-plan.test.ts`,
`family-idb/test/smoke-workflow.test.ts`.

Three committed IDB migration chains exist on disk and need regenerating
against the new code (same 3 packages 8.6.1 re-baselined):
`sync-extension-idb` (1 package, extension-space), `apps/prisma-orm-usage`
(2 packages: baseline + `add_tag`), `apps/prisma-idb-kanban-example`'s
IDB side (1 package, app-space).

## 2. Key finding that changed this phase's scope vs. the upstream ADR

IDB's rendered `migration.ts` **never imports the contract at all** —
unlike vendor's Postgres `Migration<Start, End>` base class (typed,
imports `startContractJson`/`endContractJson`), IDB's `Migration` base
class renders a bare `describe(): { from, to }` returning only the two
hashes (`target-idb/src/core/migration-planner.ts`'s `renderMigrationTs`).
So the ADR's `snapshotsImportPath` threading — every planner takes a
required POSIX-relative import path so the rendered file can
`import startContract from '../../snapshots/<hash>/contract.json'` — has
**no IDB equivalent to build**. `end-contract.json`/`.d.ts` here are pure
planning-time bookkeeping: state `migration-plan.ts` itself reads back on
the _next_ `migration plan` invocation to diff against, never state a
rendered `migration.ts` consumes. This makes the IDB port a strictly
smaller, self-contained change than the vendor original — a storage-format
swap inside code we own, not a renderer rewrite.

## 3. Decisions

1. **Write both `.json` and `.d.ts` into the store (layout parity with
   Postgres, not a reduced variant).** Nothing reads the `.d.ts` back
   today (confirmed: `planIncremental` only opens `contract.json`; no
   other call site opens `end-contract.d.ts` either). ADR 240 itself
   frames the store as holding "the emitted `contract.json`/`contract.d.ts`
   pair" — mirroring that shape keeps the two sides of this repo's stack
   (IDB and Postgres) on the same on-disk convention instead of adding a
   second, undocumented "why doesn't IDB write the `.d.ts`" special case.
   The existing "next `migration plan` will fail without it" warning text
   is corrected to describe what's actually true (only the `.json` is read
   back; the `.d.ts` copy is best-effort authoring-surface parity, not a
   read dependency) rather than deleted along with the copy path.
2. **Head-consistency check collapses, doesn't just relocate.** Today's
   `planIncremental` reads `end-contract.json`, extracts its
   `storage.storageHash`, and compares it against `migration.json`'s `to`
   field — because the sibling file has no name-level guarantee of what
   hash it holds. Once the file lives at `snapshots/<head.metadata.to>/
contract.json`, that comparison is structurally unreachable: the
   address _is_ the hash. `readStorageHash` (confirmed, only call site) is
   deleted along with the check. The new failure mode is "store entry
   missing for the hash `migration.json` claims" — a real error path with
   its own message and test, replacing the old
   `MIGRATION.CONTRACT_SPACE_VIOLATION`-shaped "inconsistent" error.
3. **`snapshots` becomes a reserved space id**, per ADR 240 — reject
   `spaceId === "snapshots"` up front with a clear error, and add
   `"snapshots"` to the existing-directory scan's filter (alongside
   `"refs"`/`"app"`) so an extension space's `migrationPlan` doesn't treat
   the shared store directory as a migration package on its next
   incremental call. This is a real bug, not defensive-only:
   `sync-extension-idb` is exactly an extension space sharing
   `migrationsDir` with the store (no `app/` subdir), so it's reachable
   today, not hypothetical.
4. **Write-if-absent + atomic rename**, per ADR 240 — check
   `snapshots/<hash>/` existence before writing; if present, skip (our
   contract emission is already deterministic/canonical, since
   `storageHash` is derived from the same bytes). Write to a temp
   directory under `snapshots/` first, then `rename` into place, so an
   interrupted write can't leave a partial entry visible under its real
   hash.
5. **`preflight.ts`'s `verifySchema` TODO stays deferred, explicitly.**
   `PLAN_8.0` §9 said the store "becomes tractable as a side effect," not
   "becomes required" — it's a new codepath (schema verification against
   a resolved-by-hash contract), not a storage-format change. Bundling it
   here would reintroduce the kind of open-ended scope creep Phase 8.8
   deliberately avoided by grep-verifying its real touch surface first.
   See §5 below.

## 4. Implementation plan

1. `migration-plan.ts`: add a `snapshots` guard (reject `spaceId ===
"snapshots"`); add `"snapshots"` to the existing-directory scan filter.
2. Replace `writeMigrationPackage`'s `end-contract.*` writes with a
   `writeContractSnapshot(migrationsDir, hash, contractRaw, contractDtsPath)`
   helper: write-if-absent, temp-dir + rename, writes both files.
3. Replace `planIncremental`'s `headEndContractPath`/`readStorageHash`
   read with a direct `snapshots/<head.metadata.to>/contract.json` read;
   missing-entry error path gets its own message + test.
4. Update `migration-plan.test.ts` and `smoke-workflow.test.ts` for the
   new paths; add the reserved-space-id test and the missing-store-entry
   test; fix the app/extension-coexistence test's directory filter to also
   exclude `"snapshots"`.
5. Regenerate the 3 committed IDB chains via the real
   `prisma-next-idb migration plan` CLI (not hand-edited) — same
   wipe-and-rebaseline precedent as 8.6.1.
6. **Diff regenerated output against the currently-committed chains.**
   Correction to this step's original assumption: `computeMigrationHash`
   hashes the whole stripped metadata envelope, which includes `createdAt`
   — so `migrationHash` moves on _every_ regeneration regardless of
   storage layout (a fresh timestamp each run), not something specific to
   this phase. The real invariant confirmed instead: `storageHash` (`to`)
   and `ops.json` content are byte-identical to the previously-committed
   chain for all 3 regenerated packages — confirmed via `git diff` against
   the pre-wipe committed files (`ops.json` identical; `storageHash`
   values `122c98a5…`, `f57f9cb9…`, `c2c485fa…` all reproduced exactly).
   That's the actual proof the storage-format swap changed nothing
   semantic; a `migrationHash` diff alone is not a stop-the-line signal
   here, since it's expected to move.
7. Full validation: `pnpm check`/`build`/`lint`/`test:prisma-next`
   repo-wide; both Playwright suites (usage + kanban).

## 5. What this does not do

- Does not implement `preflight.ts`'s deferred `verifySchema` TODO — left
  exactly as deferred as it was before this phase, now genuinely easier to
  pick up later (a direct `snapshots/<hash>/contract.json` lookup instead
  of a per-package file read), but not implemented here.
- Does not touch the Postgres side — Phase 8.8 already put it on the real
  store via the live vendor CLI; this phase only brings the IDB side to
  parity.
- Does not change `migrationHash` identity, the wire format of
  `migration.json`/`ops.json`, or anything the browser runtime
  (`createAutoMigratingIdbClient`) consumes — confirmed in §6's diff step.
