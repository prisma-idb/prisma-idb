# ADR 002: Schema changes and the marker commit in one transaction

- **Status:** Accepted
- **Date:** 2026-05-24, revised 2026-09-26
- **Area:** Migrations

## Summary

A migration applies its schema changes and writes its marker in the same IndexedDB transaction: the version-change transaction that runs `upgradeneeded`. Either both commit or neither does. The database can never have a new schema with an old marker.

## Context

A migration does two things:

1. **Change the schema.** Create or drop object stores and indexes. IndexedDB only allows this inside the `upgradeneeded` callback, which runs in a special version-change transaction.
2. **Write the marker.** Record the new contract's `storageHash` in the `_prisma_next_marker` store, so the runtime can check that the database matches the contract it was built for.

The version-change transaction can also read and write records, so both steps fit in it.

This ADR first made the opposite choice: schema changes in `upgradeneeded`, then the marker in a separate `readwrite` transaction after the open succeeded. That left a gap. If the app stopped between the two, the database had the new schema but the old marker. The next open saw the old marker and replayed the migration.

Replaying was only safe because every schema operation checks whether its store or index already exists. Record transforms ([ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md)) would break that. A transform such as "multiply `price` by 100" can't tell whether it already ran, so a replay would apply it twice.

## Decision

`openAndUpgrade` in `target-idb/src/core/apply-ddl-op.ts` does everything inside `upgradeneeded`, in this order:

1. Apply every operation with `applyOneDdlOp(db, tx, op, onDone, onError)`. Its `onDone` callback starts the next operation. The first migration also creates the marker store.
2. Put every marker record into `_prisma_next_marker`.

```
factory.open(dbName, db.version + 1)
  └── upgradeneeded (one version-change transaction)
        ├── applyOneDdlOp(db, tx, op, onDone, onError) for each op
        │     ├── createObjectStore("users", ...)
        │     ├── createIndex("users", ...)
        │     └── createObjectStore("_prisma_next_marker", ...)   first migration only
        └── put(marker) for each contract space
  └── onsuccess: close the connection
```

Markers are written after all the operations, so a marker store created by one of them already exists.

### What happens on failure

If anything throws inside `upgradeneeded`, `openAndUpgrade` aborts the transaction. IndexedDB then rolls back every schema change and marker, and the database stays at its previous version. The next open tries the whole migration again.

This includes a missing marker store. The migration chain should always create it in the first migration, so a missing store means the chain is broken. The upgrade fails with an error that names the store, instead of committing a schema nobody can verify.

When IndexedDB aborts an upgrade, the open request fails with a generic `AbortError`. `openAndUpgrade` keeps the original error and rejects with that instead.

### Concurrent opens

Two callers, in one page or in two tabs, can read the same version and plan the same next version. Only one `upgradeneeded` runs, and it carries only its own caller's operations. When an open reaches the target version without running its upgrade, `openAndUpgrade` rejects with `IdbUpgradeSupersededError` instead of reporting the operations as applied. After a lost race, the auto-migrating client reads every space's marker again, in one transaction, and returns if the winning upgrade already brought every space it asked for to its head. Otherwise it plans the next upgrade from those markers. It gives up after five lost races. An attempt whose own upgrade runs needs no second read: that upgrade writes the marker of every space that was behind.

When the winning upgrade raises the version, IndexedDB fires `versionchange` on every other open connection, including the runtime connection of a client that opened a moment earlier. That connection closes so the upgrade can run, and the driver opens a new one at the upgraded version on its next query or transaction.

When a blocked upgrade times out, `openAndUpgrade` rejects, but the open request stays queued in IndexedDB; there is no way to cancel it. If it is unblocked later, it aborts its upgrade instead of applying a migration its caller has already given up on.

### First-use marker check (added 2026-11-24)

The runtime reads the `"app"` marker once, before its first query or transaction, and again before the first use of each connection the driver opens after a newer version closed the previous one. It logs `CONTRACT.MARKER_MISSING` or `CONTRACT.MARKER_MISMATCH` with `console.warn` when it is absent or names another contract. Queries still run. Prisma 8's SQL runtime does the same check but drops the warning unless the caller passes a `log` sink. This runtime logs by default, because a missing marker in a browser app is usually a setup mistake. `verifyMarker: false` skips the check. Only the `"app"` marker is read: the runtime holds the application contract, and extension spaces such as the sync stores have their own marker rows with their own hashes.

### Schema operations still skip work that's already done

`applyOneDdlOp` still checks for an existing store or index before creating one, and for a missing one before dropping it. IndexedDB itself would throw `ConstraintError` on an existing target and abort the upgrade. A normal run no longer replays anything, but a database can still have a schema ahead of its marker, for example one left by an older build that wrote the marker separately. The checks let those databases catch up.

## Alternatives considered

- **Write the marker in a separate transaction after the open succeeds.** This was the original decision. It kept the upgrade callback limited to schema changes, and a bug in building the marker couldn't abort the schema change. Neither turned out to matter: the marker record is a plain object, and if it can't be written, rolling back the schema is the right outcome. Meanwhile the gap between the two transactions made every migration replayable, which isn't safe once migrations transform records. Replaced.
- **Let the caller write the marker after the runner returns.** A caller that forgets the marker, or stops before writing it, leaves a database that can never be verified. Rejected.

## Consequences

- **No half-migrated state.** `verifyMarker()` never sees a new schema with an old marker, because that state can't be committed.
- **Record transforms can run in the same transaction** without having to be safe to repeat ([ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md)).
- **Several contract spaces commit together.** When the app and its extensions migrate at once, all their schema changes and markers are in one transaction ([ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md)).
- **Only the migration writes `_prisma_next_marker`.** The runtime only reads it: `verifyMarker()` uses a `readonly` transaction. This matches upstream ADR 021 (Contract Marker Storage).
- **`writeMarkers` is no longer used by migrations.** It is still exported for callers that need to write a marker on its own. It now rejects when the marker store is missing, instead of logging a warning.

## Related

- `target-idb/src/core/apply-ddl-op.ts`: `openAndUpgrade`, `applyOneDdlOp`, `writeMarkers`, `readMarker`.
- `client-idb/src/core/auto-migrate.ts`: the browser code that calls `openAndUpgrade`.
- `target-idb/test/migration.test.ts`: the "schema changes and markers commit together" tests.
- [ADR 001](ADR%20001%20-%20IDB%20Version%20Integer%20as%20Migration%20Identity.md): why the version number only triggers the upgrade and the marker says which schema the database has.
