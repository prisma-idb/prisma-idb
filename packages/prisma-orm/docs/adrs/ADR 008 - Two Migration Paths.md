# ADR 008: Two migration paths

- **Status:** Superseded
- **Date:** 2026-05-25
- **Area:** Migrations, developer experience

> **Superseded.** There is now one migration path. Migrations are planned at design time with `prisma-idb migration plan`, bundled into the app with `prisma-idb migration contract-space`, and applied in the browser by `createAutoMigratingIdbClient` when the app opens the database. The browser no longer inspects the live schema or plans anything. The manifest file and the CLI apply path described below no longer exist. See [ADR 018](ADR%20018%20-%20Separate%20prisma-idb%20CLI.md) for the current commands.
>
> Two parts of this ADR still apply. They are described first.

## Still applies

### `migration.ts` must round-trip exactly

Each migration package holds the same operations in three files:

- `ops.json`: the operations the browser applies.
- `migration.json`: metadata, including `migrationHash`, a hash of `ops.json`. The browser checks it every time it walks the chain (`walkChain` in `client-idb/src/core/auto-migrate.ts`).
- `migration.ts`: an editable TypeScript version, for hand-authoring changes.

Running `node migration.ts` regenerates `ops.json` and `migration.json` from the class's `operations` getter. It writes whatever the getter returns, with no IndexedDB-specific logic. So `migration.ts` must capture every detail of the original operations. If it loses anything, editing and re-running it silently produces a different `ops.json` and a different `migrationHash` from the committed ones.

This has happened once. `renderMigrationTs` used to:

- always write `unique: false` for an index that had no `unique` value. `JSON.stringify` keeps an explicit `false` but drops a missing key, so the regenerated `ops.json` differed.
- leave out a new store's `indexes` when rendering its `createObjectStore` call.

The test `renderTypeScript() round-trips unique/multiEntry/indexes exactly (regression)` in `target-idb/test/migration.test.ts` now pins the rendered output for every combination.

### `dbName` separates tenants

IndexedDB has one level of naming: the database name passed to `indexedDB.open(name, version)`. All object stores sit directly inside that database. There are no schemas within a database.

So to keep tenants apart, give each one its own `dbName`:

```
indexedDB.open("my-app")          → users, posts, _prisma_next_marker
indexedDB.open("my-app-tenant-b") → users, posts, _prisma_next_marker
```

Each database has its own version number, stores, indexes and marker store.

Contract spaces are a different thing. They separate the app's migrations from those of its extensions, inside one database. See [ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md).

## Original decision (historical)

The rest of this record describes the design as it was decided in May 2026.

### Context

IndexedDB lives in the browser. There is no deploy step in which a CLI connects to the database before the app serves traffic. The database is opened when a user visits the page.

Teams still want:

- migration history they can review in git,
- a CI check that catches schema drift,
- a way to write data migrations (backfills, type changes) that a schema diff can't produce.

### Decision

Offer two paths that share one planner, one runner and one marker store:

- **Path A, runtime auto-migration (the default).** `createAutoMigratingIdbClient({ contract, dbName })` read the live schema and the marker. If the marker's hash matched the contract, it opened the database straight away. Otherwise it planned the difference between the live schema and the contract, applied it in `upgradeneeded`, and wrote the new marker.
- **Path B, CLI-managed migrations (opt-in).** Commands such as `db sign`, `db verify`, `migration new` and `db update` worked with git-tracked migration files. A `prisma-idb.manifest.json` file recorded the last applied IndexedDB version, and the runtime could read it to pick the right version number.

| Need                           | Path A | Path B |
| ------------------------------ | :----: | :----: |
| Local development, prototypes  |  Yes   |        |
| Single-page app with no server |  Yes   |        |
| Migration history in git       |        |  Yes   |
| CI verification                |        |  Yes   |
| Data migrations (backfills)    |        |  Yes   |
| Team review of schema changes  |        |  Yes   |

### Alternatives considered

- **Make the CLI mandatory.** Rejected: it would break the no-server, no-config use case.
- **Make runtime auto-migration the only path.** Rejected: no data migrations, no review, no CI check.
- **Separate planners for each path.** Rejected: the two paths could then produce different schema changes for the same contract.
- **Detect the path from the filesystem.** Rejected: the runtime's behaviour would depend on whether `prisma.config.ts` exists, which is hard to test. An explicit `manifest` option was clearer.
- **Write migration files from the browser.** Rejected: the browser can't write to the developer's source tree, and a production page shouldn't try.

### Consequences at the time

- `client-idb` had two entry points: `client` (no migration) and `client-auto` (auto-migration). Both still exist.
- `createAutoMigratingIdbClient` was async, because a migration might run. `createIdbClient` was synchronous. This is still true.
- The manifest was the link between the two paths. Only the CLI wrote it, so its version number could fall behind the real database. The marker's `storageHash` was always the authoritative check.
