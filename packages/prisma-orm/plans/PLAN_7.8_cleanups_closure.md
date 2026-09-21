# Phase 7.8 — Cleanups closure (Group B items)

**Status**: Not started
**Depends on**: 7.1–7.7

## Goal

Sweep up the cross-cutting items from the feedback's Group B that
weren't fully absorbed into earlier phases, and verify the items
**that were** absorbed actually landed. This is a closure checklist
plus a small amount of remaining work.

## Status of each Group B item

| Spec issue  | Description                              | Where addressed                   | Status after 7.1–7.7 |
| ----------- | ---------------------------------------- | --------------------------------- | -------------------- |
| #4          | Default policy too permissive            | 7.4 `SAFE_POLICY` constant        | Done                 |
| #5 (key)    | Marker keyed `"default"`                 | 7.3 `MARKER_KEYPATH = "space"`    | Done                 |
| #5 (fields) | Marker record only 3 fields              | 7.3 full `ContractMarkerRecord`   | Done                 |
| #6          | Duck-typed manifest detection            | 7.3 deleted entire block          | Done                 |
| #7          | `fake-indexeddb` dry-run on CLI hot path | 7.3 deleted + 7.6 added preflight | Done                 |
| Bonus       | Multi-tab `versionchange` handler        | 7.4 in `idb-client.ts`            | Done                 |

If any of these is still outstanding after 7.7, this phase completes
them. The closure questions below explicitly verify.

## Verification checklist

Run these from repo root:

```bash
# #4 — destructive ops require opt-in
rg "onDestructive" packages/prisma-orm/client-idb/src
# Expect: SAFE_POLICY default 'refuse'; AutoMigrateClientOptions exposes 'allow' override.

# #5 — marker keyed by space, not "default"
rg "MARKER_KEYPATH" packages/prisma-orm/target-idb/src
# Expect: const MARKER_KEYPATH = "space";

# #5 — full ContractMarkerRecord parity
rg "invariants|contractJson|canonicalVersion|appTag" packages/prisma-orm/target-idb/src/core/migration-runner.ts
# Expect: all four fields written in writeMarker().

# #6 — no duck-typed manifest IO
rg "readManifest|writeManifest|hasManifestIo" packages/prisma-orm/target-idb/src
# Expect: zero results.

# #7 — no fake-indexeddb in runner / hot path
rg "fake-indexeddb" packages/prisma-orm/target-idb/src
# Expect: zero results.
rg "fake-indexeddb" packages/prisma-orm/client-idb/src
# Expect: zero results (tests-only).

# Bonus — versionchange handler
rg "onversionchange|onVersionChange" packages/prisma-orm/client-idb/src
# Expect: at least one handler attached.
```

If any check fails, the gap is filled in this phase.

## Bonus cleanups not yet covered

### A) Delete dead code in family-idb

After 7.1 deleted the manifest, audit `family-idb/src/exports/` for
exports that have no consumer anymore:

```bash
rg "from ['\"]@prisma-next-idb/family-idb" packages apps --type ts
```

Anything imported only by tests of itself, or unimported, becomes a
candidate for deletion.

### B) `idb-runtime.ts` `ctx.scope` hard-coded

Project memory ([project-prisma-next-bugs.md] Issue #5) notes
`runtime-idb/src/idb-runtime.ts:100` hard-codes `ctx.scope = "runtime"`.
After Phase 6.3 landed `withMutationScope`, this should switch to
"mutation" inside the scope. Verify:

```bash
rg "ctx.scope" packages/prisma-orm/runtime-idb/src
```

Either:

- The original issue is already fixed → mark closed in memory.
- It's still wrong → fix it here (one-line change + a test).

### C) Memory updates

Update the auto-memory after this phase ships:

1. [`project-prisma-next.md`](../../../../.claude/projects/-Users-anonjr-Documents-Web-idb-client-generator/memory/project-prisma-next.md) —
   add a "Phase 7 done" entry. Mention that the manifest is gone and
   the apply flow is contract-space-based.
2. [`project-prisma-next-bugs.md`](../../../../.claude/projects/-Users-anonjr-Documents-Web-idb-client-generator/memory/project-prisma-next-bugs.md) —
   close issues #1, #2 (manifest-related), #5 (`ctx.scope` if fixed
   above), and any others that became moot. Keep #3 (codec lookup
   wiring) if unresolved.

### D) Update PLAN.md status table

Add a Phase 7 row to the top of `packages/prisma-orm/PLAN.md`:

```
| 7   | Migration package layer (Group A + B feedback) | ✅ Done — manifest deleted; ContractSpace-driven runtime; safe policy default; space-keyed marker; preflight CLI |
```

Add a "Phase 7" section linking out to the per-phase plan docs.

### E) Verify Playwright multi-tab test

The browser implementation in 7.4 adds a `versionchange` handler.
Add a Playwright test that explicitly exercises it (not just a unit
test). Skip if Playwright doesn't support multi-tab in this project's
config — log a follow-up.

## Acceptance criteria

- [ ] All verification grep checks pass.
- [ ] PLAN.md and memory files updated.
- [ ] No TypeScript errors anywhere in `packages/prisma-orm/`.
- [ ] No `IdbManifest*` symbols anywhere in `packages/` or `apps/`.
- [ ] Issue #6 (`runtime-idb/src/idb-runtime.ts` scope) verified or fixed.

## Non-goals (deferred to a future phase)

- **Backfill executable path** (`dataTransform` op end-to-end) — Phase 7
  makes this representable, not executable. The runtime needs new
  apply-path code to invoke developer closures inside the marker write
  transaction. Track separately.
- **Rename op** — same story.
- **Multi-space (extensions contributing to IDB contract spaces)** —
  space-keyed marker layout is in place; no extension API yet.
- **Hash-mismatch detection in `MigrationCLI`** — vendor warns when
  `migration.ts` was edited but not re-emitted. Our shim doesn't yet.
  Low priority; add when bitten.
