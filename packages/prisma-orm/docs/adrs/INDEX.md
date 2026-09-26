# Architecture decision records

These records explain the design decisions behind the IndexedDB (IDB) packages in `packages/prisma-orm/`. Each one covers a single decision: what we chose, why, and which alternatives we rejected.

For an overview of how the packages fit together, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Status values

- **Accepted:** decided and implemented.
- **Proposed:** drafted, not yet decided or implemented.
- **Superseded:** replaced by a later design. The record is kept for history.

## Records

| ADR | Title                                                                                                                     | Status     | Decision                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | [IDB version integer as migration identity](ADR%20001%20-%20IDB%20Version%20Integer%20as%20Migration%20Identity.md)       | Superseded | Use IDB's version number to trigger schema changes and a stored hash to check the result. The version is now just `db.version + 1`.                                                         |
| 002 | [Schema and marker in one transaction](ADR%20002%20-%20Two-Phase%20Migration.md)                                          | Accepted   | Apply the schema changes and record the new contract hash in the same `upgradeneeded` transaction.                                                                                          |
| 003 | [Plain frozen objects for the filter AST](ADR%20003%20-%20Plain%20Frozen%20Objects%20for%20Filter%20AST.md)               | Accepted   | Represent query filters as plain, frozen objects rather than classes.                                                                                                                       |
| 004 | [Driver isolation via a row-filter function](ADR%20004%20-%20Driver%20Isolation%20via%20Row%20Filter%20Closure.md)        | Accepted   | The driver receives filters as a `(row) => boolean` function, so it doesn't depend on the query language.                                                                                   |
| 005 | [No `async`/`await` inside IDB transactions](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)            | Accepted   | Chain IDB requests with callbacks, because awaiting anything else lets the transaction commit early.                                                                                        |
| 006 | [Collect rows, then yield them](ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md)                 | Accepted   | Read all result rows inside the transaction, then hand them to the caller after it completes.                                                                                               |
| 007 | [Two transaction APIs](ADR%20007%20-%20Two%20Transaction%20APIs.md)                                                       | Accepted   | Nested ORM writes work out which stores they need automatically. A manual scope API covers everything else.                                                                                 |
| 008 | [Two migration paths](ADR%20008%20-%20Two%20Migration%20Paths.md)                                                         | Superseded | Offered both browser auto-migration and CLI-applied migrations. Now the browser is the only place migrations are applied.                                                                   |
| 009 | [Foreign keys and referential actions](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)     | Accepted   | The client checks foreign keys on every write and runs `onDelete`/`onUpdate` actions itself. Both default to `restrict`, which rejects the same changes as Postgres's default, `NO ACTION`. |
| 010 | [Apply all contract spaces in one transaction](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md)    | Accepted   | Migrations for the app and its extensions apply in one upgrade transaction, so they succeed or fail together.                                                                               |
| 011 | [Don't copy extension migrations into apps](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md) | Accepted   | Extension packages keep their own migrations. Apps import them instead of copying them into their own repo.                                                                                 |
| 012 | [Client contract subsetting](ADR%20012%20-%20Client%20Contract%20Subsetting.md)                                           | Accepted   | One schema produces both the server contract and a smaller client contract. `@idb.exclude` marks what stays off the client.                                                                 |
| 013 | [Relations to excluded models](ADR%20013%20-%20FK%20Projection%20on%20Excluded%20Models.md)                               | Accepted   | A relation to an excluded model is dropped from the client contract. Its foreign-key field is kept, and a warning is shown.                                                                 |
| 014 | [Sync ownership graph](ADR%20014%20-%20Sync%20Ownership%20DAG.md)                                                         | Accepted   | The sync server authorizes pushes and scopes pulls by following relations from each record back to a root model, such as `User`.                                                            |
| 015 | [Validation derived from the contract](ADR%20015%20-%20Contract-Derived%20Validation.md)                                  | Proposed   | Validate synced records against validators built from the contract at runtime, not generated code.                                                                                          |
| 016 | [Record transforms in migrations](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md)           | Proposed   | Add a migration operation that rewrites existing records, described as data rather than code.                                                                                               |
| 017 | [Native IndexedDB features](ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md)                                     | Accepted   | Use compound keys, native `count()` and key-only reads where IDB supports them. Report "transaction inactive" errors clearly.                                                               |
| 018 | [A separate `prisma-idb` CLI](ADR%20018%20-%20Separate%20prisma-idb%20CLI.md)                                             | Accepted   | Three migration commands the `prisma` CLI can't provide for a browser database live in a small companion CLI, for now.                                                                      |
| 019 | [Apply planned migrations as written](ADR%20019%20-%20Apply%20Planned%20Migrations%20As%20Written.md)                     | Accepted   | The browser applies every planned operation, destructive ones included. Destructive changes are flagged at plan time.                                                                       |

## Reading order for sync

ADRs 012, 013 and 014 build on each other. Read them in order:

1. [ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md) decides which models the client gets.
2. [ADR 013](ADR%20013%20-%20FK%20Projection%20on%20Excluded%20Models.md) decides what happens to relations that point at models the client doesn't get.
3. [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md) decides who may read and write each synced record, using the models and relations left after 012 and 013.

Two options were ruled out while making these decisions:

- **One ORM shared by client and server.** The browser can't reach the server database, so there is no point exposing its models there.
- **Using the framework's `model.owner` for sync authorization.** `model.owner` says where data is stored together. It doesn't say who may access it. ADR 014 explains the difference.

## Upstream ADRs we build on

These are ADRs from the upstream Prisma framework.

| Upstream ADR                                  | What it defines                                            | How it affects these packages                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR 001: Migrations as Edges                  | Migrations as edges between contract hashes                | The browser walks these edges to migrate the database.                                                                                                                                                                                |
| ADR 005: Thin Core, Fat Targets               | Keep the core small and put database logic in targets      | All packages follow it.                                                                                                                                                                                                               |
| ADR 011: Unified Plan Model                   | One immutable plan shape for every query lane              | Shape of `IdbQueryPlan` in `adapter-idb`.                                                                                                                                                                                             |
| ADR 014: Runtime Hook API                     | Plugin hooks around query execution                        | `runtime-idb` and `IdbMiddleware`.                                                                                                                                                                                                    |
| ADR 015: ORM as Optional Extension            | The ORM is a layer over the runtime, not part of it        | `client-idb` is optional on top of `runtime-idb`.                                                                                                                                                                                     |
| ADR 016: Adapter SPI for Lowering             | How adapters turn queries into plans, and capabilities     | The `adapter-idb` descriptor and its `lower()` function.                                                                                                                                                                              |
| ADR 021: Contract Marker Storage              | The migration runner writes a marker; the runtime reads it | [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md). IDB stores one marker row per contract space.                                                                                                                                    |
| ADR 104: PSL Extension Namespacing            | The `@namespace.attribute` syntax in schemas               | `@idb.exclude` and `@@idb.exclude` use it ([ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md)).                                                                                                                             |
| ADR 177: Ownership Replaces Relation Strategy | `model.owner`, for storing data together                   | Deliberately not used for sync authorization ([ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md)).                                                                                                                                  |
| ADR 212: Contract Spaces                      | Separate migration histories per extension                 | Apps and extensions each have their own migration chain ([ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md), [ADR 011](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md)). |
