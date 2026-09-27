# Prisma 8 IDB architecture

This document explains how the packages in `packages/prisma-orm/` fit together: what each package does, which code runs where, and what happens when an app runs a query, ships a migration or syncs. It's written for contributors. For how to use the packages, see the docs site. For why a design choice was made, see the [ADR index](adrs/INDEX.md).

## Two planes: build time and run time

Prisma 8 splits every database integration into two planes:

| Plane             | Runs in                     | Does                                                        |
| ----------------- | --------------------------- | ----------------------------------------------------------- |
| **Control plane** | Node.js, from the CLI       | Emits contracts, plans migrations, checks migration history |
| **Runtime plane** | The browser (or Node tests) | Opens the database, applies migrations, runs queries        |

The split keeps build-time code out of browser bundles. Each package exposes separate entrypoints for each plane, usually `./control` and `./runtime`, and `./control` entrypoints serve the CLI. The one exception is an extension's `./control` entrypoint, such as `@prisma-idb/sync-extension-idb/control`: it holds the extension's contract space, which the browser needs to migrate the database, so app code imports it.

IndexedDB bends this split in one place. A server database is migrated from the CLI, but IndexedDB only exists in the browser. So migrations are _planned_ on the control plane and _applied_ on the runtime plane, when the app opens the database ([ADR 018](adrs/ADR%20018%20-%20Separate%20prisma-idb%20CLI.md)).

## The packages

Six packages implement IndexedDB as a Prisma 8 database family. Three more add optional sync with a server.

| Package              | Plane   | Job                                                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `client-idb`         | Runtime | The typed ORM (`db.orm.user.where(...).all()`) and the functions that open a client.                          |
| `runtime-idb`        | Runtime | Connects the adapter and driver, runs middleware, checks the contract marker.                                 |
| `adapter-idb`        | Both    | Turns an ORM query plan into a plan the driver can run. Declares the target's capabilities.                   |
| `driver-idb`         | Runtime | Runs plans against the IndexedDB API. Owns connections and transactions.                                      |
| `target-idb`         | Both    | Codecs, contract storage types, key comparison, and the migration system: planner, operations, apply code.    |
| `family-idb`         | Control | Reads PSL schemas into IDB contracts, plugs the family into the `prisma` CLI, and ships the `prisma-idb` CLI. |
| `sync-extension-idb` | Runtime | Browser side of sync: an outbox written in the same transaction as each write, and a push/pull worker.        |
| `sync-server`        | Server  | Builds the ownership graph from the schema and says what to check for each pushed or pulled record.           |
| `sync-server-sql`    | Server  | Runs those checks and the writes against a Prisma 8 SQL client.                                               |

The core stack, from the app down:

```
app code
   │
   ▼
client-idb      typed ORM; builds query plans, enforces relations
   │
   ▼
runtime-idb     middleware, marker check
   │
   ▼
adapter-idb     query plan → driver plan (a passthrough today)
   │
   ▼
driver-idb      runs the plan in an IndexedDB transaction
   │
   ▼
indexedDB

target-idb      used by all of the above: codecs, contract types, key helpers, migrations
family-idb      control plane only: schema reading and CLI integration
```

## How a query runs

When the app calls `db.orm.user.where({ active: true }).all()`:

1. **`client-idb` builds the plan.** The store accessor turns the chained calls into an `IdbQueryPlan`. The plan carries a driver-level plan (`idbPlan`), which already contains everything the driver needs: the store, an optional index and key range, and plain functions for any filtering and sorting the key range can't express ([ADR 004](adrs/ADR%20004%20-%20Driver%20Isolation%20via%20Row%20Filter%20Closure.md)). It also carries an `ast` describing the query, for middleware to inspect.
2. **`runtime-idb` receives the plan** through `query(plan)`, runs each middleware's `beforeExecute`, and asks the adapter to lower the plan.
3. **`adapter-idb` lowers the plan.** Today this returns `plan.idbPlan` unchanged, because every IDB codec stores values as they are. Encoding would happen here if a codec ever needed it.
4. **`driver-idb` runs the plan.** It opens a transaction, walks a cursor or calls `get`, `getAll`, `count` or `getKey`, and collects every matching row before the transaction ends ([ADR 006](adrs/ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md)). Requests are chained through IndexedDB callbacks, never `await`, so the transaction stays active ([ADR 005](adrs/ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)).
5. **`runtime-idb` yields the rows,** calling each middleware's `onRow` and then `afterExecute`.

Most writes take a different route: they need to read and write several stores in one transaction. `client-idb`'s mutation executor calls `withMutationScope`, which opens one multi-store transaction through the runtime's `transaction()`. It then runs driver plans directly on the returned `IdbTransactionScope` to check foreign keys, apply referential actions and write the rows ([ADR 007](adrs/ADR%20007%20-%20Two%20Transaction%20APIs.md), [ADR 009](adrs/ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)). Middleware doesn't see these steps.

| Write                                                 | Route                     |
| ----------------------------------------------------- | ------------------------- |
| `create`, `createAll`, with no foreign-key fields set | `query()`, as one plan    |
| `delete`, when no relation needs enforcing            | `query()`, as one plan    |
| `create` or `createAll` that sets a foreign key       | Transaction scope         |
| `delete` with relations to enforce                    | Transaction scope         |
| `update`, `updateAll`, `upsert`, `deleteAll`          | Transaction scope, always |
| Nested writes (relation callbacks)                    | Transaction scope, always |

Sync hooks into both routes. It extends single plans into a batch that also writes the outbox, and it wraps the transaction scope so each write in it records an outbox event.

## How a schema change reaches the browser

### At build time

```
developer edits schema.prisma
  │
  ├── prisma contract emit
  │     writes contract.json and contract.d.ts
  │
  ├── prisma-idb migration plan --name <slug>
  │     diffs the newest migration's contract against the new one
  │     writes migrations/app/<timestamp>_<slug>/{migration.ts, migration.json, ops.json}
  │     writes migrations/snapshots/<storageHash>/{contract.json, contract.d.ts}
  │     warns on stderr if the migration drops a store
  │
  ├── prisma-idb migration contract-space
  │     writes contract-space.generated.ts, which imports every package
  │
  └── prisma-idb migration preflight        (in CI)
        applies every ops.json, in order, to an in-memory fake-indexeddb
```

Each migration package records the contract hash it starts `from` and the hash it ends `to`. Packages form a single chain from an empty database to the current contract. The contract snapshots are stored once per hash, and the next `migration plan` diffs from the newest one.

### In the browser

```
createAutoMigratingIdbClient({ contractSpace, dbName, extensions })
  │
  ├── 1. open the database and read every marker from _prisma_next_marker
  ├── 2. if each space's marker already matches its head, skip to step 5
  ├── 3. walk each space's chain from its marker to its head, collecting every pending operation
  ├── 4. reopen at db.version + 1; inside upgradeneeded, in one transaction:
  │       ├── apply every operation (extension spaces first, the app space last)
  │       └── write every space's new marker
  └── 5. return createIdbClient({ contract, dbName })
```

Everything in step 4 commits together or not at all ([ADR 002](adrs/ADR%20002%20-%20Two-Phase%20Migration.md), [ADR 010](adrs/ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md)). The browser applies each chain exactly as it was planned, including destructive operations ([ADR 019](adrs/ADR%20019%20-%20Apply%20Planned%20Migrations%20As%20Written.md)).

The IndexedDB version number only triggers `upgradeneeded`. The marker, keyed by space id (`"app"`, `"idb-sync"`, …), is what records which contract the database has ([ADR 001](adrs/ADR%20001%20-%20IDB%20Version%20Integer%20as%20Migration%20Identity.md)).

## How sync fits in

Sync is an extension. It adds its own stores and its own migration chain, and wraps the ORM client. It doesn't change the core packages.

- **In the browser,** `sync-extension-idb` wraps the client's executor. Every tracked write also writes an outbox event and a version record in the same IndexedDB transaction, so a write can't commit without its event. A `SyncWorker` pushes outbox events to the app's server and pulls changes back.
- **On the server,** the app owns the HTTP routes and the database. `sync-server` reads the schema's relations once at startup and builds an ownership graph from each synced model back to a root model, usually `User` ([ADR 014](adrs/ADR%20014%20-%20Sync%20Ownership%20DAG.md)). For each pushed event or pulled changelog row, it returns a description of what to check. `sync-server-sql` runs those checks and the writes against a Prisma 8 SQL client.

One `schema.prisma` serves both sides. The browser's contract leaves out fields and models marked `@idb.exclude` or `@@idb.exclude`. The server's config strips those attributes and adds a `Changelog` model ([ADR 012](adrs/ADR%20012%20-%20Client%20Contract%20Subsetting.md)).

## Package reference

### `target-idb`

| Entrypoint    | Plane   | Contains                                                                                                                                         |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.`, `./pack` | Neither | The target's identity (`familyId: "idb"`, `targetId: "idb"`) and codec descriptors. Plain data.                                                  |
| `./control`   | Control | The target descriptor the CLI loads. It carries the migration planner and runner.                                                                |
| `./runtime`   | Runtime | The runtime descriptor and codecs, key comparison helpers, and the apply code the browser uses: `openAndUpgrade`, `applyOneDdlOp`, `readMarker`. |
| `./migration` | Control | What a `migration.ts` file imports: the `Migration` base class, `MigrationCLI`, the operation factories, the planner and `diffIdbSchema`.        |

Every IDB codec (`idb/string@1`, `idb/date@1`, and so on) stores values as they are, since IndexedDB can store `Date`, `Uint8Array` and `BigInt` directly.

**Key comparison.** `keyEquals`, `fieldValuesEqual` and `compareFieldValues` compare values the way IndexedDB compares keys: `Date` and binary values by content, and different types in IndexedDB key order. The ORM uses them for filters, sorting, joins and foreign-key checks, so a `DateTime` field behaves the same whether or not it's indexed ([ADR 003](adrs/ADR%20003%20-%20Plain%20Frozen%20Objects%20for%20Filter%20AST.md)).

### `adapter-idb`

| Entrypoint  | Plane   | Contains                                                                                                                         |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `./control` | Control | The adapter descriptor: the mapping from Prisma scalar types to codec ids, and the capabilities.                                 |
| `./runtime` | Runtime | The runtime descriptor with `lower()`, the `IdbQueryPlan` and `IdbFilterExpr` types, the filter factories, and `evaluateFilter`. |

**Capabilities** live on the adapter, not the target. The IDB adapter declares `transactionalDDL: true`, `ddlOnlyInUpgrade: true`, `returning: false` and `compoundKeys: true`.

Depends on `target-idb` and `driver-idb` (for the driver's plan types).

### `driver-idb`

| Entrypoint  | Plane   | Contains                                                                                                                 |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `./control` | Control | A stub driver. The framework requires a `driver` in `prisma.config.ts`, but no CLI command can reach a browser database. |
| `./runtime` | Runtime | `createIDBRuntimeDriver`, the plan types (`IdbPlanBody`, `IdbAtomicPlan`), `IdbTransactionScope`, and `IdbExecuteError`. |

A plan is plain data plus functions. The kinds are `cursor-scan`, `key-get`, `index-get`, `add`, `put`, `update`, `delete`, `scan-write`, `count`, `keys`, and `batch`, which runs several plans in one transaction. The driver has no dependencies inside this repo. It doesn't know about models, relations or contracts.

Adding a plan kind touches five places ([ADR 017](adrs/ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md)): `plan-body.ts`, `execute/ops.ts`, a new error code, the exhaustive switch in `sync-extension-idb`'s `sync-executor.ts`, and the driver's runtime type exports.

### `runtime-idb`

One entrypoint, `./runtime`, exporting `createIdbRuntime`, `IdbRuntime` and `IdbMiddleware`. The runtime extends the framework's `RuntimeCore`:

| Method                      | Does                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `query(plan)`               | Lowers the plan, runs it, and yields rows through the middleware hooks.   |
| `transaction(stores, mode)` | Opens an `IdbTransactionScope` that runs driver plans without middleware. |
| `verifyMarker()`            | Checks that the database's marker matches the contract's `storageHash`.   |
| `close()`                   | Closes the connection.                                                    |

Middleware gets a context with a `contentHash(plan)` function. It hashes the plan's data and skips its functions, so equal queries produce equal hashes and a cache middleware can use them as keys. Because rows are collected before they are yielded, `onRow` runs over rows already in memory. It can't slow down the cursor.

Depends on `adapter-idb` and `driver-idb`.

### `client-idb`

| Entrypoint      | Contains                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./orm`         | `idbOrm({ contract, executor })`, the accessor types, and the `and`, `or` and `not` filter helpers. Bring your own executor.                                      |
| `./client`      | `createIdbClient({ contract, dbName })`, which builds the driver, adapter, runtime and ORM. Also `createManagedIdbClient`.                                        |
| `./client-auto` | `createAutoMigratingIdbClient({ contractSpace, dbName, extensions })`, which migrates first. Also `createManagedAutoIdbClient` and the lower-level `autoMigrate`. |

All three are runtime only. The main files in `src/core/`:

| File                   | Does                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `store-accessor.ts`    | The per-model accessor: chaining, reads, writes, `include`, `count`, `aggregate`.               |
| `query-shaping.ts`     | Turns `where` and `orderBy` into key ranges, filter functions and comparators.                  |
| `mutation-executor.ts` | Nested writes, foreign-key checks and referential actions, inside one transaction.              |
| `relation-loader.ts`   | `include()`: loads related rows in batches and joins them in memory.                            |
| `auto-migrate.ts`      | Walks the contract space's chains and applies pending operations.                               |
| `managed-client.ts`    | The singleton wrapper with a `reset()` that deletes the database safely, for example on logout. |

Depends on `target-idb`, `adapter-idb`, `driver-idb` and `runtime-idb`.

### `family-idb`

| Entrypoint       | Contains                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `./control`      | The family descriptor the `prisma` CLI loads.                                                 |
| `./contract-psl` | `prismaIdbContract(path, { projection })`, which reads a `.prisma` file into an IDB contract. |
| `./contract-ts`  | `defineContract()`, for writing a contract in TypeScript instead of PSL.                      |
| `./config-types` | `defineConfig` for `prisma.config.ts`, and helpers for TypeScript-authored contracts.         |
| `./pack`         | The family's identity. Plain data.                                                            |
| `./cli`          | The `prisma-idb` commands, for embedding. The package also installs the `prisma-idb` binary.  |

`family-idb` is never imported by browser code. The `prisma-idb` binary has three commands, `migration plan`, `migration contract-space` and `migration preflight`, described in [ADR 018](adrs/ADR%20018%20-%20Separate%20prisma-idb%20CLI.md).

The `prisma` CLI's commands that need a live database can't work for IndexedDB. The family answers them without failing the type contract: `verify` and `sign` return a failure whose summary explains why, and `introspect` and the marker reads return empty results.

Depends on `target-idb`. `fake-indexeddb` is a dependency only for `migration preflight`.

### `sync-extension-idb`

| Entrypoint  | Contains                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `./control` | `idbSyncExtension`: the extension's contract space (`_idb_sync_outbox` and `_idb_sync_version_meta`), passed to `extensions`.   |
| `./client`  | `createSyncIdbClient`, `createAutoMigratingSyncIdbClient`, `createManagedAutoSyncIdbClient`, the `SyncWorker`, and `applyPull`. |
| `./schemas` | Zod schemas for the push and pull wire formats. Safe to import on a server: no IndexedDB code.                                  |

### `sync-server` and `sync-server-sql`

`sync-server` never touches a database or an HTTP framework. Its main export is `createSyncServer({ contract, clientContract, rootModel })`, which returns `validatePush` and `buildPullQueries`. `./schema` and `./postgres` build the server's contract from the shared schema, adding the `Changelog` model.

`sync-server-sql` exports `createSqlSyncAdapter`, which runs the ownership checks, push writes and pull reads against a Prisma 8 SQL ORM client, and `sqlGetKeyField`, which finds a primary key in a SQL contract.

## Dependency graph

Dependencies between packages in this repo:

- `driver-idb` depends on nothing in this repo.
- `adapter-idb` depends on `target-idb` and `driver-idb`.
- `runtime-idb` depends on `adapter-idb` and `driver-idb`.
- `client-idb` depends on `target-idb`, `adapter-idb`, `driver-idb` and `runtime-idb`.
- `family-idb` depends on `target-idb`.
- `sync-extension-idb` depends on the core packages.
- `sync-server` depends on `family-idb`, only to strip `@idb.exclude` attributes when building the server's schema.
- `sync-server-sql` depends on `sync-server`.

## Glossary

| Term                  | Meaning                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contract**          | The emitted description of the schema (`contract.json` and its `.d.ts`). Its `storageHash` identifies the storage layout.                               |
| **Contract space**    | A contract plus its chain of migrations and a head. The app has one (`"app"`); each extension ships its own.                                            |
| **Marker**            | A record in `_prisma_next_marker`, one per space, holding the `storageHash` the database is at. Written by migrations, read by `verifyMarker()`.        |
| **Migration package** | A folder under `migrations/<space>/` with `migration.ts` (the readable source), `ops.json` (the operations) and `migration.json` (hashes and metadata). |
| **Operation (op)**    | One schema change: create or drop an object store or index.                                                                                             |
| **Descriptor**        | A plain object describing a package to the framework: its identity, plus a `create()` factory.                                                          |
| **Codec**             | Converts one scalar type between JavaScript and storage. Codec ids are versioned, such as `idb/date@1`.                                                 |
| **Plan**              | A query or write described as data. `client-idb` builds `IdbQueryPlan`s; the driver runs `IdbPlanBody`s.                                                |
| **`upgradeneeded`**   | The IndexedDB event fired when a database opens at a higher version. It's the only place object stores and indexes can be created or dropped.           |
| **Projection**        | Which parts of the schema a contract includes. `"client"` leaves out everything marked `@idb.exclude`.                                                  |
| **Ownership graph**   | The graph `sync-server` builds from each synced model, through its N:1 relations, back to the root model. Used to authorize sync.                       |

## Out of scope

- **A one-package facade.** Apps install the packages they need; there is no `@prisma-idb/idb` wrapper.
- **SQL.** IndexedDB is a key-value store. There is no SQL layer; plans map straight to IndexedDB calls.
- **The old generator.** `packages/generator` is the earlier, codegen-based client. These packages don't share code with it.
