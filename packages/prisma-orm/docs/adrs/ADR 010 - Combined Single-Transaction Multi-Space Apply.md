# ADR 010: Apply all contract spaces in one transaction

- **Status:** Accepted
- **Date:** 2026-08-02
- **Area:** Migrations

## Summary

An app and its extensions, such as the sync extension, each have their own migration history, called a contract space. When several spaces have pending migrations, the browser applies all their schema changes in one `upgradeneeded` transaction, with a single version bump. The same transaction writes all their markers. Either every space migrates or none does, and the user sees at most one "blocked by another tab" cycle.

## Context

`createAutoMigratingIdbClient({ extensions: [...] })` lets an extension own its own contract space, separate from the app's. Upstream ADR 212 (Contract Spaces) requires multiple spaces to be applied inside one outer transaction, so that a failure part-way through rolls back every space, instead of leaving some migrated and others not.

## Decision

The browser collects the pending operations for the app space and for each extension space, then:

1. Opens the database at `db.version + 1` to start one `upgradeneeded` transaction.
2. Rechecks the applied markers and validates store ownership against the live stores in apply order. If the marker state changed during planning, the upgrade aborts before any operation runs.
3. Applies every space's operations and writes every migrated space's marker in that transaction.

```text
autoMigrate: pending spaces "app" and "idb-sync"
  └── openAndUpgrade(version v + 1, ops = idb-sync ops, then app ops, markers = [idb-sync, app])
        └── upgradeneeded (one transaction):
              create _idb_sync_outbox, _idb_sync_version_meta    (idb-sync)
              create _prisma_next_marker (first migration only), app stores    (app)
              put marker "idb-sync", put marker "app"
```

`autoMigrate` in `client-idb/src/core/auto-migrate.ts` collects the pending operations for each space, and throws on a broken chain before the database is touched. It then makes one `openAndUpgrade` call (`target-idb/src/core/apply-ddl-op.ts`) with every space's operations and markers.

### Order of operations

Extension spaces go first, sorted by space ID independently of locale, and the app space goes last. This follows the [upstream apply order](https://github.com/prisma/orm/blob/17385f2d86eefa3783e86d94534168a224806c0a/packages/1-framework/3-tooling/migration/src/concatenate-space-apply-inputs.ts).

The app baseline can create `_prisma_next_marker` last because marker writes follow all operations. A name can be reused only after its current owner releases it in this apply order. For example, the app can use a name an extension drops earlier in the same upgrade.

## Why combining is safe

- **Scope.** A version-change transaction already covers every store in the database. Combining several spaces' operations only saves extra calls to `indexedDB.open`.
- **One owner at a time.** Extension prefixes such as `_idb_sync_` keep names disjoint. A space can create a store under a name released by a previous space in apply order. The client starts from ownership at the applied markers, including stores created by migrations outside their space’s declared schema. It applies each create and drop to that ownership map and checks that the result matches the destination contracts. It rejects overlapping claims and operations on existing stores whose owner cannot be determined. The client can replay a create for a store ahead of its marker if the pending operations and destination contracts identify one owner and every live marker belongs to a configured space. A handoff of a store that already exists requires a marker recording the current IndexedDB version. The client starts recording that version on a fresh database and advances it with atomic upgrades. Legacy markers lack that proof, so the client rejects a live handoff when an earlier split write could have already changed the store's owner.
- **Failure rolls everything back.** If anything throws, the whole transaction aborts, every space's schema changes and markers with it, and the next open tries again ([ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md)).

## Alternatives considered

### One `openAndUpgrade` call per space

The first working design migrated each space separately, with its own version bump, its own `upgradeneeded` transaction and its own marker write. The app space always went first.

It had to go first because of how the marker store gets created. In Postgres, the framework creates its control tables in a separate bootstrap step (`ensureControlTables`, upstream ADR 021) before any space migrates. IndexedDB has no such step: `_prisma_next_marker` is created by the app's own baseline migration. So if an extension had migrated first, its marker write would have found no marker store.

This design had two problems:

1. **Not atomic.** If the app stopped between two spaces, the database was left partly migrated. The next open recovered by replaying, but that isn't what ADR 212 requires.
2. **Several version bumps.** A first launch that needed the app and an extension caused several upgrade cycles. Each one can fire `onblocked` when another tab has the database open.

Combining the spaces fixes both, and removes the app-first rule as a side effect.

### Other options

- **Keep one transaction per space, but reorder them.** This would still not be atomic, and would still need an ordering rule between transactions.
- **Create the marker store in a separate bootstrap step**, like Postgres does. This fixes the ordering problem only. The single combined transaction was needed for atomicity anyway, and it fixes ordering too.

## Consequences

- **Applying several spaces is atomic.** Every space's schema changes and markers commit together, or nothing does.
- **One upgrade cycle.** A first launch causes exactly one upgrade, and at most one `blocked` cycle, however many spaces need migrating.
- **`openAndUpgrade` takes a `markers` array**, not a single `marker`.
- **A handoff depends on apply order.** The releasing space must run before the claiming space. For a verified legacy database, apply the release on every affected device before the claiming upgrade. Fresh databases still need the full migration chains to release the name before claiming it.

## Related

- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md): why schema changes and markers share one transaction.
- [ADR 011](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md): how an extension's migrations reach the app in the first place.
- `client-idb/src/core/auto-migrate.ts`: `autoMigrate`.
- `target-idb/src/core/apply-ddl-op.ts`: `openAndUpgrade`.
