# ADR 002 — Two-Phase Migration: DDL in upgradeneeded, Marker Write Separately

## Context

IDB migrations involve two distinct operations:

1. **DDL** — creating/dropping object stores and indexes. This can only happen inside the `upgradeneeded` callback, which fires inside a version-change transaction.
2. **Marker write** — writing the `storageHash` and `profileHash` into the `_prisma_next_marker` object store so the runtime can verify schema correctness.

The version-change transaction that carries DDL is technically capable of also writing data records. The `_prisma_next_marker` store exists after DDL creates it, so the marker record could be written in the same version-change transaction. The question is: should we?

## Decision

Split migration into two sequential phases:

**Phase 1 — DDL (inside `upgradeneeded`):**
Open at `targetVersion`. In the `upgradeneeded` callback, apply all `IdbDdlOp` operations (create/drop stores, create/drop indexes). The marker store itself is created here on first migration.

**Phase 2 — Marker write (separate `readwrite` transaction):**
After the version-change transaction commits and the database is open at the new version, open a separate `readwrite` transaction on `_prisma_next_marker` and write the marker record (`storageHash`, `profileHash`, `updatedAt`).

The runner owns both phases. The caller (CLI or family instance) writes `idbVersion` to the manifest only after both phases succeed.

### Sequence

```
factory.open(dbName, targetVersion)
  └── upgradeneeded fires
        └── applyDdlOps(db, tx, ops)
              ├── createObjectStore("users", ...)
              ├── createIndex("users", ...)
              └── [first migration only] createObjectStore("_prisma_next_marker", ...)
  └── onsuccess fires → db is open at targetVersion
        └── writeMarker(db, { storageHash, profileHash, updatedAt })
              └── db.transaction("_prisma_next_marker", "readwrite")
                    └── store.put(markerRecord)
```

## Why not write the marker inside `upgradeneeded`?

There are two reasons:

**Separation of concerns.** The version-change transaction exists to change the schema. Writing data inside it mixes DDL and DML concerns in a single callback. Separating them makes the runner easier to reason about: phase 1 is schema-only, phase 2 is data-only.

**Race window is recoverable.** There is a short window between phase 1 completing and phase 2 completing where the schema exists but the marker doesn't. If the process crashes in this window, `verifyMarker()` returns `false` (and on the next auto-migrate the marker still reads the old hash). The next migration run re-collects the already-applied ops from the chain walk and replays them inside a fresh `upgradeneeded`, then re-attempts the marker write.

This recovery is only safe because **`applyOneDdlOp` is explicitly idempotent** — each op is guarded by an existence check (`db.objectStoreNames.contains(...)` / `store.indexNames.contains(...)`) so a replayed `createObjectStore`/`createIndex` is a no-op instead of a throw.

> **Correction (2026-06-04).** An earlier version of this ADR claimed DDL ops are "idempotent under 'store already exists' semantics (IDB's own guarantee)". That is **false** — IndexedDB's `createObjectStore` and `createIndex` throw `ConstraintError` when the target already exists; there is no such guarantee. Before the guards were added (PLAN Issue #25), a crash in the phase-1/phase-2 window left the database **permanently wedged**: every subsequent open replayed the create ops, aborted the version-change transaction on `ConstraintError`, and failed identically forever. The idempotency now lives in `applyOneDdlOp` (`target-idb/src/core/apply-ddl-op.ts`), covered by the "crash-recovery replay" regression tests in `target-idb/test/migration.test.ts`.

## Failure modes

| Failure point                     | Result                                                                         | Recovery                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Crash during DDL (phase 1)        | IDB rolls back the version-change transaction; database remains at old version | Next run retries from phase 1                                                                                     |
| Crash between phase 1 and phase 2 | Database is at new version; marker is absent or stale                          | Next migration run replays the collected ops (idempotent no-op via the existence guards) and re-writes the marker |
| Crash during phase 2              | Marker write aborted                                                           | Same as above                                                                                                     |

## What we deliberately did not do

**Single-phase migration:** Writing the marker inside `upgradeneeded` would eliminate the failure window but would make the runner harder to understand — DDL callbacks are not a natural place for data writes, and any bug in marker serialization could corrupt the schema transaction.

**Marker written by the caller (not the runner):** We considered having the caller write the marker after the runner returns, keeping the runner a pure DDL executor. We rejected this because the marker is tightly coupled to migration correctness — if the runner succeeds but the caller forgets to write the marker (or crashes), the database is permanently unverifiable. Owning the marker write inside the runner keeps the invariant local.

## Consequences

- The runner is the sole writer of `_prisma_next_marker`. The runtime reads but never writes it (confirmed: `verifyMarker()` opens a `"readonly"` transaction).
- The manifest's `idbVersion` is written by the caller only after both phases succeed. If the caller crashes between phase 2 and the manifest write, the next run will re-attempt migration at the same `targetVersion` — DDL is a no-op, marker write is idempotent.
- This means `idbVersion` in the manifest can lag one behind the actual IDB version in edge cases. The `storageHash` comparison is the authoritative check; `idbVersion` is used only to compute `targetVersion`.

## Related

- [ADR 001](ADR%20001%20-%20IDB%20Version%20Integer%20as%20Migration%20Identity.md) — overall migration identity model
- Upstream ADR 021 — Contract Marker Storage (ownership invariant: runner writes, runtime reads)
- `target-idb/src/core/migration-runner.ts` — implementation
