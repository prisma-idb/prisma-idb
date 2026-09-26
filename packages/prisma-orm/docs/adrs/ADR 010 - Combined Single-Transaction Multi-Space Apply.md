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

1. Opens the database once, at `db.version + 1`, and applies every space's operations in that one `upgradeneeded` transaction.
2. Writes every migrated space's marker in the same transaction, after all the operations.

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

Extension spaces go first, sorted by space id, and the app space goes last. This follows upstream ADR 212's convention.

The order is safe for two reasons:

- **Markers are written after every schema change**, including the app baseline's creation of `_prisma_next_marker`. So no marker is ever written to a store that doesn't exist yet.
- **IndexedDB schemas have no references between stores.** In Postgres, an app table may use a type that an extension installs, so the order matters. Here it doesn't.

## Why combining is safe

- **Scope.** A version-change transaction already covers every store in the database. Combining several spaces' operations only saves extra calls to `indexedDB.open`.
- **No overlap.** Each extension uses its own store-name prefix, such as `_idb_sync_` for the sync extension. Operations from different spaces never touch the same store, so their order can't cause a `ConstraintError`.
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
- **Extension authors don't have to think about ordering** relative to the app space.

## Related

- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md): why schema changes and markers share one transaction.
- [ADR 011](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md): how an extension's migrations reach the app in the first place.
- `client-idb/src/core/auto-migrate.ts`: `autoMigrate`.
- `target-idb/src/core/apply-ddl-op.ts`: `openAndUpgrade`.
