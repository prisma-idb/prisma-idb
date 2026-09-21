# Phase 8.2 — Content-hash migration-tree conversion (rc.4)

Stack layer: `feat/prisma-8` → `phase-8.2-content-hash`. Depends on 8.1 only.

## 0. Scope correction — read this first

`PLAN_8.0` §9 defines this phase as: strip `sha256:` (codemod), **run
`migrate-migrations-layout.mjs` per root**, re-verify every `migrationHash`,
fix `migration-hash.ts`. Its §3 item 2 also asserts the content-addressed
snapshot-store layout is "a clean break with no fallback reader — an
unconverted tree fails to load entirely once the toolchain is upgraded."

Both of those are wrong for Tier 1, on two independent grounds confirmed
before writing any code:

1. **The vendor migrator isn't runnable from this repo.**
   `vendor/prisma/scripts/migrate-migrations-layout.mjs` imports
   `@internal/framework-components/control` and
   `@internal/migration-tools/{contract-snapshot-store,hash,io}` —
   workspace-private packages that only resolve inside `vendor/prisma`'s own
   pnpm workspace. `vendor/prisma` has no `node_modules` installed (it's a
   read-only reference clone per this repo's own convention), so the script
   cannot be run as-is, and `pnpm install`ing that entire separate monorepo
   just to run one script is disproportionate and out of scope.

2. **Our own code never reads the store layout, so it was never actually
   required — and upstream itself says the store isn't load-bearing anyway.**
   [ADR 240](../../../vendor/prisma/docs/architecture%20docs/adrs/ADR%20240%20-%20Contract%20snapshots%20live%20in%20a%20content-addressed%20store.md)
   (Accepted) states this directly: "`migration apply` reads only
   `migration.json` and `ops.json` per package; it never touches
   `snapshots/`... A project can delete `migrations/snapshots/` entirely and
   still `migrate` an app-space chain end-to-end; `snapshots/` is authoring
   and planning surface, not an apply input." So even on rc.4's own reference
   implementation, an unconverted (or store-less) tree is not a "fails to
   load entirely" scenario at apply time — the earlier §0 draft overstated
   this. What we actually call at runtime, independently confirming the same
   conclusion for our own pipeline:
   - `contractSpaceFromJson` (`@prisma/orm-toolchain/migration-tools/spaces`,
     used by every `contract-space.generated.ts`) — its rc.4 signature is
     `{ contractJson: unknown; migrations: { dirName, metadata, ops }[];
headRef }`. No snapshot store, no `snapshotsImportPath`, confirmed by
     reading `spaces-B20bgxF9.d.mts` directly.
   - `family-idb/src/core/preflight.ts` — reads `ops.json` only; its own
     comment says schema verification against `end-contract.json` is
     "deferred to a follow-up," i.e. not implemented.
   - `family-idb/src/core/migration-plan.ts` — writes/reads
     `end-contract.json`/`.d.ts` as **hand-rolled sibling files**
     (`join(packageDir, "end-contract.json")`, direct `writeFile`/`readFile`),
     never `writeContractSnapshot`/`readContractSnapshotJson`. It also never
     rewrites `migration.ts` import specifiers to point at snapshots — our
     Phase 7 class-based `Migration`/`MigrationCLI` shim doesn't import
     contract snapshots by relative path at all; `describe()` just returns
     `{ from, to }` hash strings.

   Net effect: adopting the content-addressed store (`migrations/snapshots/
<hex>/`) is a **real, available design option** for `migration-plan.ts`/
   `preflight.ts` going forward — not a port requirement. Don't read "not
   done in 8.2" as "decided against"; it's simply out of this phase's scope.
   `PLAN_8.0` §3 item 2 and §9's 8.2 row should be read with this
   correction until someone restructures those sections directly.

This was double-checked with a second read before implementation started:
the only public toolchain call that sits on the snapshot side of the house
(`contractSpaceFromJson`) was independently re-verified against its actual
`.d.mts` to confirm it takes metadata+ops only, which is the fact the whole
narrowing rests on.

## 1. What this phase actually does

1. **Strip `sha256:` from the 3 Tier-1 checked-in migration trees.** Ran the
   upstream `0.16-to-0.17` codemod
   (`vendor/prisma/skills/prisma-next-upgrade/upgrades/0.16-to-0.17/
strip-sha256-hash-prefixes.ts`) unmodified — it's self-contained (no
   `@internal/*` imports, reimplements canonicalize+hash inline) — with cwd
   set to each root in turn (`--check` first, then for real):
   - `apps/prisma-orm-usage/migrations`
   - `apps/prisma-idb-kanban-example/migrations` (IDB side only)
   - `packages/prisma-orm/sync-extension-idb/migrations`

   `migrations-postgres` (Tier 2) and
   `sync-server-sql/test/fixtures/migrations-postgres` are excluded —
   confirmed the latter is pure test fixture data, never loaded through
   rc.4's loader by any Tier-1 test.

   Contract hash values (`storageHash`/`profileHash`/`from`/`to`) keep their
   value, only the prefix drops. `migrationHash` values are recomputed
   (the hashed bytes embed the `from`/`to` strings) — captured the
   old→new map and swept the repo for stale references to the old values;
   none existed outside the converted trees.

2. **Extended the strip to the 3 root `contract.json`/`.d.ts` files**
   (`sync-extension-idb/src/contract.*`, both example apps'
   `src/lib/prisma/contract.*`) — not part of the codemod's own scope (they
   sit outside any migration-package/snapshot dir), but **not optional**:
   `migration-plan.ts`'s head-check does a literal string compare between
   the head migration's `to` and the root contract's `storageHash`, so
   leaving these prefixed would break that check the moment a new migration
   is planned. Verified byte-equality of all three head/contract pairs
   after the edit.

3. **Fixed the two other real (non-fixture) prefixed values**: the
   Playwright e2e's `V1_STORAGE_HASH` constant
   (`apps/prisma-orm-usage/tests/migration.spec.ts`) and a doc-comment
   example in `target-idb/src/exports/migration.ts`.

4. **`client-idb/src/core/migration-hash.ts`**: `computeMigrationHash` now
   returns bare hex — the browser-safe WebCrypto reimplementation dropped
   its own `sha256:` prefix. Algorithm itself is unchanged (already
   structurally identical to `@prisma/orm-toolchain/migration-tools/hash`'s
   rc.4 version — both do `hash([hash(strippedMeta), hash(ops)])`).

5. **Added the hash-identity test `PLAN_8.0` flagged as missing** — no test
   previously compared our browser implementation's output against a real
   CLI-recorded hash, only against its own shape.
   `client-idb/test/migration-hash.test.ts` feeds
   `sync-extension-idb`'s converted `migration.json`/`ops.json` into
   `computeMigrationHash` and asserts the result equals that manifest's own
   `migrationHash`. (`client-idb` has no `@types/node` by design — browser
   safety is the whole point of this file's existence — so the fixture is
   read via a JSON import assertion, and `resolveJsonModule` was added to
   its `tsconfig.json` rather than pulling in Node ambient types.)

6. **Fixed the 2 target-idb test failures `PLAN_8.1`'s validation already
   attributed to this phase** (`idb-migration.test.ts`,
   `migration-cli.test.ts`, both asserting `toMatch(/^sha256:/)` against a
   real, framework-computed `migrationHash`) plus the same pattern in
   `family-idb/test/smoke-workflow.test.ts` (`v1.storageHash`/
   `v2.storageHash`). Changed to `toMatch(/^[0-9a-f]{64}$/)`.

   Left untouched: every synthetic fixture literal (`"sha256:A"`,
   `"sha256:test-to-hash"`, `"sha256:wrong-head-hash"`, …) used as an opaque
   test-input string, never compared against real computed output. These
   don't assert a production hash format, so there's nothing to fix.

## 2. Validation

- `pnpm build` — green, 16/16 tasks, repo-wide.
- `pnpm check` — same failures as `PLAN_8.1`'s baseline, no new ones:
  `family-idb`/`adapter-idb` red on `extensionPacks`/`scalarTypes`/
  `scalarTypeDescriptors` (Phase 8.3 / the unresolved 8.1 finding). Verified
  by running `tsc --noEmit` standalone in every package this phase actually
  touched (`target-idb`, `family-idb`, `client-idb`, `sync-extension-idb`) —
  all clean beyond those pre-existing errors.
- `pnpm test:prisma-next` — `target-idb`: 84/84 (was 82/84 per Phase 8.1).
  `family-idb`: 1 pre-existing failure remains
  (`CONTRACT.TARGET_MISMATCH` vs `PN-RUN-3003` — the structured-error-code
  rename, Phase 8.3's job), unrelated to hashing. `client-idb`/
  `sync-extension-idb`/`runtime-idb`: all remaining failures are the
  `this.runExecute is not a function` `RuntimeCore` split (Phase 8.4) —
  confirmed by grepping every failure's stack trace, no `AssertionError`
  hiding among them. `sync-server-sql`/`cli-tests`: unchanged from Phase
  8.1's baseline (extensionPacks / config-unification, Phases 8.3/8.5).

No Playwright/e2e run in this phase (deferred to 8.7 per `PLAN_8.0` §8.4);
the one e2e fixture with a real hash value (`migration.spec.ts`) was fixed
by inspection since it's a straightforward value-preserving edit.

## 3. Guidance for future sessions

- Don't attempt the content-addressed store conversion as a "finishing"
  step for this phase — it's a design decision for `migration-plan.ts`/
  `preflight.ts`, tracked as open, not a leftover.
- If a future phase (or the store-adoption design work, if picked up)
  needs the vendor migrator's actual logic, port it against the **public**
  subpaths the way this phase's investigation mapped them
  (`@internal/framework-components/control` →
  `@prisma/orm-framework/components/control`,
  `@internal/migration-tools/{contract-snapshot-store,hash,io}` →
  `@prisma/orm-toolchain/migration-tools/{contract-snapshot-store,hash,io}`)
  rather than trying to run vendor's copy directly.
- `PLAN_8.0` §3 item 2 and §9's 8.2 row have already been updated directly
  (in this same PR) with the ADR 240 correction and the deferred Phase 8.9
  entry — no further correction note is needed there.
