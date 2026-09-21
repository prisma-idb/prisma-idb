# ADR 010 — Combined Single-Transaction Multi-Space Apply

## Status

Decided — implemented.

## Context

Phase 7 added multi-space migration support (`createAutoMigratingIdbClient({ extensions: [...] })`) so IDB extensions like the sync extension can own their own contract space, disjoint from the application's. Upstream [ADR 212 — Contract spaces](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20212%20-%20Contract%20spaces.md) requires multi-space apply to run inside one outer transaction, so a failure partway through rolls back every space's writes rather than leaving some spaces migrated and others not.

## Decision

`autoMigrate` collects pending ops from the app space and every extension space, then applies **all of them in one combined `upgradeneeded` transaction** (one IDB version bump total), followed by **one batched marker-write transaction** covering every space that migrated.

### What changed to support this

- `target-idb/src/core/apply-ddl-op.ts`: `openAndUpgrade`'s `marker?: MarkerWriteInput` field became `markers?: readonly MarkerWriteInput[]`. `writeMarkers(db, inputs)` opens **one** `readwrite` transaction on `_prisma_next_marker` and `put`s every marker inside it (`tx.oncomplete` resolves once, covering all of them). `writeMarker(db, input)` is kept as a thin `writeMarkers(db, [input])` wrapper for the common single-marker case.
- `client-idb/src/core/auto-migrate.ts`: `autoMigrate` collects `pendingPerSpace` per space (this is where the destructive-op refusal check happens, before any database is touched), then flattens every pending space's ops into one array and calls `openAndUpgrade` exactly once, with `targetVersion: initialVersion + 1` and a `markers` array built from every pending space.

### Sequence

```text
autoMigrate([{spaceId:'app', ops:[...]}, {spaceId:'idb-sync', ops:[...]}])
  └── openAndUpgrade(targetVersion = v+1, ops = idb-sync.ops ++ app.ops, markers = [idb-sync, app])
        └── upgradeneeded (ONE transaction):
              creates _idb_sync_outbox, _idb_sync_version_meta   (idb-sync's ops)
              creates _prisma_next_marker (first-ever migration), app stores  (app's ops)
        └── onsuccess:
              writeMarkers (ONE transaction): put('idb-sync', ...), put('app', ...)
```

### Op ordering within the combined transaction

Ops are ordered **extensions alphabetical-by-spaceId first, app-space last**, matching upstream ADR 212's stated convention. This is safe because marker writes happen in the separate phase-2 transaction, which only runs after **all** phase-1 DDL — including the app space's `_prisma_next_marker`-creation op — has already committed. Relative op order inside phase 1 has no effect on marker-write safety; IDB object stores have no forward schema references at DDL time regardless (unlike Postgres, where extension-installed native types must exist before app tables can reference them — see "Alternative considered" below for why that distinction matters).

## Why this is safe to combine

- **DDL scope.** A `versionchange` transaction already spans every object store in the database — concatenating ops from disjoint spaces into one transaction is not new IndexedDB territory, just fewer round trips through `IDBFactory.open`.
- **Store disjointness.** Every extension space uses a distinct store-name prefix by convention (the sync extension: `_idb_sync_*`); app-space and extension-space ops never target the same store, so op order across spaces cannot produce a `ConstraintError` collision.
- **Existing idempotency guarantees are untouched.** `applyOneDdlOp`'s existence-check guards ([ADR 002](./ADR%20002%20-%20Two-Phase%20Migration.md)) still make a replayed DDL op a no-op; a crash during phase 1 still rolls back the whole (now-larger) transaction and phase 1 replays cleanly from scratch on the next `autoMigrate` run.
- **Marker-write batching reuses the exact two-phase split** ADR 002 established — this design only changes _how many_ markers land in phase 2's transaction (N in one, instead of N separate ones), not the phase 1/phase 2 boundary itself.

## Alternative considered and rejected: one `openAndUpgrade` call per space

The first working design applied each pending space via its own separate `openAndUpgrade` call — its own version bump, its own `upgradeneeded` transaction, its own marker-write transaction — with the app space always applying first.

That ordering constraint existed for a real reason, worth recording because it explains _why_ the combined design below is more than a performance tweak: in Postgres, marker-table creation is a framework-internal bootstrap step (`ensureControlTables`, upstream [ADR 021](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20021%20-%20Contract%20Marker%20Storage.md)) that runs _before_ any space migrates, decoupled from both app-space and extension-space work — so extension-first ordering is free to follow the real schema dependency direction (app tables may reference extension-installed types). IDB has no equivalent bootstrap phase: `_prisma_next_marker` is created as one of the **app baseline's own DDL ops** (the planner prepends it whenever it plans from `fromContract: null`). Under the per-space-transaction design, if an extension's `openAndUpgrade` ran before the app space's, its marker write would target a `_prisma_next_marker` store that didn't exist yet — so app-first was the only safe order, and extension authors had to know not to reorder things.

This design had two problems:

1. **No cross-space atomicity.** N separate transactions meant a crash between space 1 and space 2 left the database genuinely partially migrated — recoverable on next load via [ADR 002](./ADR%20002%20-%20Two-Phase%20Migration.md)'s idempotent-replay guarantee, but not atomic, and not what upstream ADR 212 requires.
2. **N version bumps instead of 1.** A cold start needing both the app space and an extension space produced N separate `upgradeneeded`/`blocked` cycles instead of one — worse multi-tab UX (`onblocked` fires once per bump).

Both are exactly what the combined-transaction design above fixes. It also happens to remove the app-first ordering constraint entirely: since marker writes now happen in a phase strictly after all DDL commits, the relative order of spaces' DDL ops no longer affects marker-write safety, so op order was free to match upstream ADR 212's extension-first convention instead.

## What we deliberately did not do

**Write markers inside the same `upgradeneeded` transaction as the DDL.** ADR 002 already rejected mixing DDL and marker writes in one callback for separation-of-concerns reasons; that reasoning is unchanged by combining spaces, so the two-phase split stays intact — phase 2 just writes N records instead of 1.

**Keep per-space transactions but just reorder them to match ADR 212.** This would still leave the atomicity gap unaddressed and would still need _some_ ordering rule between transactions (even a "safe" one), where the combined-transaction design needs none.

**Make `_prisma_next_marker` creation a decoupled framework bootstrap step (mirroring `ensureControlTables`).** This was the other theoretical fix for the per-space design's ordering constraint. Rejected in favor of the combined-transaction design because it only solves the ordering problem, not the atomicity or version-bump-count problems — and once you're combining every space's DDL into one transaction anyway (needed for atomicity regardless), the ordering problem disappears as a side effect, for free.

## Consequences

- Multi-space apply is atomic: either every pending space's DDL and marker both land, or (on any failure) none of phase 1 commits and nothing in phase 2 runs. The database never ends up with, e.g., the app space migrated and the sync extension not, mid-transaction. (A crash _between_ phase 1 committing and phase 2 completing is still possible and still safe-but-not-atomic — the same recoverable window ADR 002 already describes, now covering all spaces at once instead of one.)
- Cold-start multi-space apply triggers exactly one `upgradeneeded`/`blocked` cycle regardless of how many spaces have pending work.
- `openAndUpgrade`'s public signature is `markers` (array), not a singular `marker`.
- Extension authors do not need to reason about declaration order relative to the app space at all.

## Related

- [ADR 002](./ADR%20002%20-%20Two-Phase%20Migration.md) — the DDL/marker-write phase split this design batches within.
- [ADR 001](./ADR%20001%20-%20IDB%20Version%20Integer%20as%20Migration%20Identity.md) — IDB version integer as the DDL trigger mechanism this design builds on.
- Upstream [ADR 212 — Contract spaces](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20212%20-%20Contract%20spaces.md) — `executeAcrossSpaces`' single-outer-transaction requirement, which this design matches in spirit for IDB.
- Upstream [ADR 021 — Contract Marker Storage](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20021%20-%20Contract%20Marker%20Storage.md) — `ensureControlTables` as the SQL family's decoupled bootstrap step; IDB has no equivalent, which is why the rejected per-space design needed app-first ordering.
- `target-idb/src/core/apply-ddl-op.ts` — `openAndUpgrade`/`writeMarkers` implementation.
- `client-idb/src/core/auto-migrate.ts` — `autoMigrate` implementation.
