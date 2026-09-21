# Phase 8.3 — Contract-layer breaks (rc.4)

Stack layer: `feat/prisma-8` → `phase-8.2-content-hash` → `phase-8.3-contract-layer`. Depends on 8.1 only.

## 0. Scope correction — read this first

`PLAN_8.0` §9 defines this phase as including "re-emit every contract." That
step does **not** happen in this phase — it's deferred to Phase 8.5, on two
independent grounds confirmed before writing any code:

1. **Every IDB-side `contract emit` shells out to the dead `prisma-next@0.16.0`
   CLI.** `sync-extension-idb/package.json` and both example apps'
   `package.json` all define `contract:emit` as `prisma-next contract emit
[--config ...]`; `family-idb/src/bin/prisma-idb.ts`'s own doc comment
   names the same command as workflow step 1. `PLAN_8.1_mechanical_import_
rewrite.md` §3 already proved this binary is dead against rc.4-shaped
   config (`prisma-next contract emit` returns `PN-CLI-4009: Config.extensions
is not supported; use Config.extensionPacks` — the 0.16.0 CLI rejects the
   very config our own `defineConfig` now produces). The only CLI capable of
   `contract emit` against rc.4 config is whatever Phase 8.5 (config
   unification) and 8.6 (CLI mounting) build — not the one we have today.
2. **The rename is hash-inert, so there's no urgency forcing an emit anyway.**
   `PLAN_8.0` §3 item 3 claimed `extensionPacks`→`extensions` changes every
   contract's `storageHash`/`executionHash`/`profileHash` on re-emit. Checked
   directly against the installed rc.4 `.d.mts`:
   `computeStorageHash({ target, targetFamily, storage })`,
   `computeProfileHash({ target, targetFamily, capabilities })`, and
   `computeExecutionHash({ target, targetFamily, execution })` each take only
   the named fields — none accepts `extensions`/`extensionPacks`, and the
   canonicalization module they share doesn't reference either name. So the
   claim was wrong: leaving the checked-in `contract.json`/`.d.ts` files
   stale (still `extensionPacks: {}`) carries no hash-mismatch risk, and once
   8.5 unblocks a real re-emit, every hash is expected to come back
   byte-identical.

Net effect: this phase is a pure source-level fix to our own
contract-authoring code (the object-literal shape a fresh `contract emit`
would produce), not a data migration of checked-in artifacts. `PLAN_8.0` §3
item 3 and §9's 8.3/8.5 rows have been updated in place with this
correction — see them for the full evidence, including the concrete
downstream symptom this leaves in place until 8.5 lands (below).

## 1. What this phase actually does

1. **`extensionPacks` → `extensions`, 3 sites.** Confirmed via live `tsc`
   errors (not grep-guessed) in `family-idb`:
   `src/core/contract-builder.ts:472`, `src/core/psl-interpreter.ts:1099`,
   `test/_raw-contract.ts:38`. Straight key rename — value (`{}`) unchanged
   in all three; this is the object literal our own authoring pipeline
   constructs and passes through `validateContract`, not a data conversion.

2. **`sourceFormat`→`format`/`outputPath`→`output` riders: confirmed absent.**
   Grepped Tier 1's own config plumbing — neither key appears anywhere in our
   `prisma-next.config.ts` files or `defineConfig` call sites. Nothing to
   change.

3. **Error-code sweep: re-verified the "read-through" claim, found and fixed
   two real hits it had missed.** `PLAN_8.0`'s original sweep only grepped
   for `instanceof <LegacyErrorClass>` patterns (correctly found none) but
   didn't catch **hardcoded legacy code strings compared by value**, which is
   a different pattern for the same underlying break (structured error codes
   moved from `PN-<DOMAIN>-<NNNN>` to dotted `NAMESPACE.SUBCODE`):
   - `family-idb/test/control.test.ts:81` asserted
     `expect(result.code).toBe("PN-RUN-3003")` — a stale literal for what the
     framework's own `VERIFY_CODE_TARGET_MISMATCH` constant now evaluates to
     (`"CONTRACT.TARGET_MISMATCH"`, confirmed in the installed
     `control-BE92GNIR.d.mts`). Our source (`control-instance.ts`) already
     correctly used the framework constant — only the test hardcoded the old
     value. Fixed by importing `VERIFY_CODE_TARGET_MISMATCH` into the test
     instead of comparing against a literal.
   - `family-idb/src/core/schema-verify.ts:507` defined its **own local**
     `const VERIFY_CODE_SCHEMA_FAILURE = "PN-RUN-3010"` — a real source bug,
     not a test-only staleness. The framework exports the same-named constant
     (`VERIFY_CODE_SCHEMA_FAILURE = "CONTRACT.SCHEMA_VERIFICATION_FAILED"`
     from `@prisma/orm-framework/components/control`); our local shadow was
     never updated to import it. Fixed by deleting the local constant and
     importing the framework's.

   Both were caught by re-running the full grep sweep for every legacy
   `PN-<DOMAIN>-<NNNN>`-shaped literal across Tier 1 (not just
   `instanceof` checks) — worth doing as its own step in future phases that
   touch error handling, since it catches a different failure mode than the
   `instanceof` sweep.

4. **Confirmed, via a stash-and-diff check, that `apps/prisma-idb-kanban-example`'s
   `svelte-check` failure (7 errors, `Property 'extensions' is missing in
type 'Contract'`) is pre-existing, not a regression from this phase.**
   Reverted this phase's 5 file changes, rebuilt `family-idb`, reran the
   app's `pnpm check` — identical 7 errors, byte-for-byte. Root cause: the
   checked-in `contract.d.ts` files (both apps, `sync-extension-idb`) still
   declare `extensionPacks`, while rc.4's `Contract` type has required
   `extensions` since Phase 8.1 landed the import rewrite — this mismatch
   predates this phase's rename and will persist until Phase 8.5 unblocks a
   real re-emit. `apps/prisma-orm-usage` has the identical stale field in
   its own `contract.d.ts` but doesn't surface the error, since its app code
   doesn't assert the JSON-imported contract against
   `IdbContract`/`Contract<IdbStorage>` as strictly as kanban's `db.ts` does
   — a pre-existing difference in how tightly each app's code binds to the
   type, not something this phase changed.

## 2. Out of scope, deliberately

- **Re-emitting `contract.json`/`.d.ts`** for any of the 3 Tier-1 roots — see
  §0. Tracked as part of Phase 8.5's scope now.
- **`scalarTypes`/`scalarTypeDescriptors`** (`adapter-idb/src/core/
descriptor-meta.ts`, `family-idb/src/core/psl-provider.ts` + 2 test
  fixtures) — a genuinely different, unrelated root cause (`vendor/prisma`
  commit `72cd71550f`, PSL scalar-authoring unification, #1022), discovered
  by Phase 8.1 and left open there after real investigation. Folding it into
  this phase would repeat the mistake Phase 8.2 avoided (don't widen a
  mechanical-rename phase into an unrelated architecture problem). Given its
  own deferred phase, **8.10**, in `PLAN_8.0` §9.

## 3. Validation

- `pnpm build` — green, repo-wide.
- `family-idb` standalone `tsc --noEmit`: the 3 `extensionPacks` errors are
  gone. The 3 `scalarTypes` errors remain (`psl-provider.ts`,
  `contract-psl.test.ts`, `smoke-workflow.test.ts`) — unrelated, tracked as
  Phase 8.10. **`family-idb` does not pass `tsc --noEmit` clean after this
  PR** — this is expected and out of scope here, not a regression to chase.
- `adapter-idb` standalone `tsc --noEmit`: unchanged, still red on
  `scalarTypeDescriptors` only (Phase 8.10) — confirmed this phase touches
  nothing `adapter-idb` depends on.
- `family-idb test` (vitest): **201/201 passing** (was 200/201 before the
  `control.test.ts` error-code fix).
- `sync-extension-idb`, `client-idb`, `cli-tests`, `sync-server` standalone
  `tsc --noEmit`: all clean, no new errors from this phase (checked
  individually since the repo-wide `pnpm check` pipeline aborts early on
  `runtime-idb`'s pre-existing Phase 8.4 `RuntimeCore` failure).
- `apps/prisma-orm-usage` `svelte-check`: clean, 0 errors.
- `apps/prisma-idb-kanban-example` `svelte-check`: 7 errors, confirmed
  pre-existing via stash-and-diff (§1 item 4) — not this phase's regression.
- `sync-server-sql` `check`: unchanged from Phase 8.1's baseline (shells out
  to the same dead CLI for its own `contract:emit:postgres` step — Tier 2 /
  Phase 8.5 territory, not touched here).

No Playwright/e2e run in this phase (deferred to 8.7 per `PLAN_8.0` §8.4).

## 4. Guidance for future sessions

- Don't attempt to re-emit any checked-in contract as a "finishing" step for
  this phase — it needs a working `contract emit`, which needs Phase 8.5.
  See §0.
- Don't fold `scalarTypes`/`scalarTypeDescriptors` into this phase or treat
  `family-idb`'s remaining `tsc` errors as something this phase should have
  fixed — see §2. It's Phase 8.10.
- When Phase 8.5 lands a working `contract emit` and re-emits every Tier-1
  contract: expect the diff to be small (just `extensionPacks`→`extensions`
  plus whatever else has drifted since these were last emitted) and expect
  every `storageHash`/`profileHash`/`executionHash` to come back unchanged,
  per §0 item 2. If a hash _does_ change, that's a real signal something
  else moved — don't assume it's this rename.
- If you're re-running the error-code sweep for a later phase: grep for the
  legacy `PN-<DOMAIN>-<NNNN>` literal pattern directly (not just
  `instanceof <ErrorClass>`) — that's what caught both real hits in this
  phase's §1 item 3, and the `instanceof`-only sweep would have missed both.
- `PLAN_8.0` §3 item 3 and §9's 8.3/8.5 rows have already been updated
  directly (in this same PR) with this phase's corrections — no further
  correction note is needed there.
