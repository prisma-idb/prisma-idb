# @prisma-idb/target-idb

## 0.10.0

### Minor Changes

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Remove `IdbMigrationControlDriver`, `IdbMigrationControlDriverDescriptor`, and `extractMigrationDriver` from `/control` and `/migration`. Use the stub driver from `@prisma-idb/driver-idb/control` in CLI configuration; migrations apply in the browser through the client factories.

## 0.9.1

### Patch Changes

- [#259](https://github.com/prisma-idb/prisma-idb/pull/259) [`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Tidy codecs and migration planning. No behavior change.

  - Move the `idb/bytes@1` base64 code into named helpers that build their lookup table once.
  - Share one contract `storage` lookup between `contractToIdbSchema` and the storage hash extraction.
  - Remove helper re-exports from the migration runner module that no package entry point used.
  - Correct comments that described behavior the code no longer has.

## 0.9.0

### Minor Changes

- [#247](https://github.com/prisma-idb/prisma-idb/pull/247) [`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Validate synced records and keys using cached arktype validators derived from the contract. Extra fields and invalid enum values are rejected without mutating input.

  Push checks now return a `validation-failure` check with `RECORD_VALIDATION_FAILURE` or `KEYPATH_VALIDATION_FAILURE` before ownership work. SQL pushes validate create records and partial update patches, returning non-retryable failures before opening a transaction. Consumers of `validatePush` must handle the new check kind. The exported low-level `validatePush` function now requires the client contract as its third argument; the bound `SyncServer.validatePush` signature is unchanged.

  Pulls validate decoded records and keys before writing, report corrupt rows through `validationFailed` in both `ApplyPullResult` and `pullcompleted`, and advance the cursor past corrupt rows while valid rows in the same batch still apply.

  SQL push validation retains wire-form keys for ownership checks and changelog JSON, while ORM lookups use native keys. BigInt root and scoped keys round-trip through push and pull without getting stuck in the outbox.

  Required JSON scalars accept JSON `null` independently of database nullability, while missing values and `undefined` remain invalid. Pull cursor documentation now explains that advancing past a later applied or corrupt row can also pass an earlier transaction failure; cursor behavior is unchanged.

  SQL pushes encode required Postgres JSON nulls at the ORM write boundary so create and update succeed instead of becoming stuck retryable events.

  SQL validation covers legacy Date/time codecs and native text arrays. Unsupported contract validators fail at server construction instead of rejecting pushes at runtime.

  Push record validation and construction preflight use only client-visible fields. Required server-only fields must be supplied by the server before insertion; key validation and ownership checks retain the full server contract.

  Malformed SQL pull keys now carry an explicit `validationError: "KEYPATH_VALIDATION_FAILURE"` marker without a record. Updated clients consume it as a validation failure without deleting local rows, including delete logs. Ordinary null records still delete revoked ownership. Deploy marker-aware clients before servers emitting the new variant. The client and SQL adapter pull types derive from the shared wire schema.

## 0.8.0

### Minor Changes

- [#234](https://github.com/prisma-idb/prisma-idb/pull/234) [`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Support Prisma `8.0.0-rc.12` (`prisma@8.0.0-rc.17`). The packages now depend on `@prisma/orm-framework` / `@prisma/orm-toolchain` `8.0.0-rc.12` and `@prisma/cli-engine` `0.6.1`.

  - IDB codecs declare a `dataType`, and the IDB target registers those data types, so `prisma contract emit` works again.
  - The PSL contract providers (`prismaIdbContract`, `sqlContractWithSync`) use the new multi-document parser API. Diagnostics point at the configured schema path.
  - The `prisma-idb` CLI no longer imports the removed `finalizeConfig`. The config section now resolves `contract.output` / `migrations.dir` itself.
  - To-one relations carry the `nullable` flag the emitter now requires. PSL derives it from the relation field (`User?`). `defineContract` derives it from the local FK fields and accepts an explicit `nullable` override.
  - `contract.d.ts` types an index without a `unique` flag as `unique: false`.
  - The sync server's Postgres `defineConfig` binds `DateTime` to the JS-`Date` codec (`pg/timestamptz-date@1`). rc.12's default Temporal codec needs a global `Temporal` that Node 24 does not provide, and IDB clients sync `Date`s. The column type is still `timestamptz`.
  - `applyPushEvent` turns ISO strings on `DateTime` fields back into `Date`s before writing, because push payloads arrive as JSON.

  Re-emitted contracts keep the same `storageHash`, so existing IndexedDB databases need no migration.

- [#234](https://github.com/prisma-idb/prisma-idb/pull/234) [`1f885dd`](https://github.com/prisma-idb/prisma-idb/commit/1f885dd0c24fa3fb42d23cc1539997915f264288) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Support Prisma enum blocks and enum-typed fields in PSL and `defineContract`, including optional fields, lists, defaults, generated literal-union types, and string-based filtering.

  - The ORM client now rejects a create, update, or upsert that sets an enum field to an undeclared value, a non-array list value, or `null` on a required field. IndexedDB has no native enum type to reject these values.

## 0.7.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Migrations now write their contract markers inside the same `upgradeneeded` transaction as their schema changes, so the two commit together or not at all. Previously the markers were written in a separate transaction after the upgrade. If the app was closed in between, the database kept the new schema with the old marker, and the next open replayed the migration.

  A failed upgrade now rejects with the error that caused it, instead of IndexedDB's generic `AbortError`. If the marker store is missing when markers need writing, the upgrade fails and rolls back. It used to log a warning and commit the schema without a marker. `writeMarkers` likewise rejects when the marker store is missing, instead of warning and resolving.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds compound primary keys and compound secondary indexes. `@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` (PSL) and the equivalent TS-DSL `keyPath`/`IndexDef.keyPath` arrays now map directly to IndexedDB array `keyPath`s (`createObjectStore(name, { keyPath: [...] })` / `createIndex(name, [...])`). Previously `@@id([...])` was rejected with a claim that IndexedDB doesn't support compound keys, which is not true, so schemas with join tables or composite natural keys couldn't target the IDB family at all. Default compound index names join the member fields (`byUserId_effectiveFrom`-style), and schema diffing/verification and DDL emission are array-aware.

  `client-idb` builds and compares keys through shared helpers (`extractKeyFromRow`, `keyEquals`, `keyToken`), so compound keys work across `findUnique`, `update`, `delete`, `upsert`, cascades and `include()`. `keyEquals`/`keyToken` also compare `Date` and binary keys by value (including inside compound keys) rather than by reference. `CreateInput` now only makes the primary key optional when something actually fills it: a single-field `@default(autoincrement())` key (IndexedDB's key generator) or a key with its own `@default` such as `uuid()`/`cuid()`. A plain `@id` with no default, and every compound-key member without its own `@default`, is now required, since IndexedDB can't generate those keys and `create()` would otherwise fail at runtime with a `DataError`. Compound and `multiEntry` indexes are deliberately not used for single-field equality acceleration; accelerating them is left to the query planner.

  **Breaking (`client-idb`):** `getKeyPath` now throws when a model has no `storage.keyPath` instead of silently falling back to `"id"`, which used to mask malformed contracts.

  `sync-server` doesn't support compound-key models yet; `createSyncServer` now says so explicitly (and how to work around it) instead of reporting a generic "not a string keyPath" error.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fixes filters and sorting on `DateTime` and `Bytes` fields that aren't indexed. Values read back from IndexedDB are fresh objects, so the in-memory filter's `===` never matched two equal dates: `where({ createdAt: date })`, `eq` and `in` returned nothing, and `neq` returned the matching rows. The same query on a key or an indexed field worked, because it went through a key range. Filters now compare values the way IndexedDB compares keys, so the result no longer depends on whether a field is indexed.

  `orderBy` had the same problem. Equal dates never tied, so a second `orderBy` field was never used to break the tie. Sorting now follows IndexedDB's key order, with `null` last (first when descending).

  `target-idb/runtime` now exports the shared comparison helpers: `compareFieldValues`, `fieldValuesEqual`, `fieldValueToken`, `isValidIdbKey`, `keyEquals` and `keyToken`. `client-idb` still re-exports `keyEquals` and `keyToken`.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - - Running a hand-edited `migration.ts` to re-emit its artifacts now warns on stderr when the migration drops a store, like `prisma-idb migration plan` does. The warning text is exported from `@prisma-idb/target-idb/migration` as `deletedDataWarning`.
  - A migration whose marker write fails after the schema changes, for example on a quota or constraint error, now rejects with that error instead of a generic `AbortError`.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - - `isValidIdbKey` now rejects invalid `Date`s and arrays with holes or repeated (including cyclic) references, matching what IndexedDB accepts. A cyclic array used to overflow the stack.
  - `fieldValueToken` now gives strings their own prefix, so no string can share a token with a `Date`, binary or array value.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Referential actions now match what Postgres does with the same Prisma 8 schema, so a synced app's client and server allow the same changes.

  - **`onUpdate` defaults to `restrict`**, not `cascade`. Changing a value that children refer to now throws unless the relation declares `onUpdate: Cascade`, `SetNull` or `SetDefault`. Prisma 8 emits no `ON UPDATE` clause for an undeclared action, so Postgres rejects the change; the client used to cascade it locally and then fail on push.
  - **`noAction` behaves like `restrict`**, as `NO ACTION` does in SQL. It used to turn enforcement off, so the client would delete or change a parent that the server refused to, leaving dangling references locally.

## 0.6.1

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

## 0.6.0

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

## 0.5.0

### Minor Changes

- [#213](https://github.com/prisma-idb/prisma-idb/pull/213) [`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Closes out the three ADR 009 referential-action follow-ups: recursive (multi-hop) `onDelete` cascade, `onUpdate` referential actions (`@relation(onUpdate: ...)`, defaulting to `cascade`), and `setDefault` support backed by a new `IdbModelStorage.fieldDefaults`/`ModelDef.fieldDefaults` map of literal `@default(...)` values. `update()`/`updateAll()`/`updateCount()`/`upsert()` now enforce `cascade`/`setNull`/`setDefault`/`restrict`/`noAction` the same way delete already did, including transitive multi-hop propagation with cycle-safe recursion.

  Also adds `defineContract` validation rejecting a relation and its reciprocal both declaring the same `onDelete`/`onUpdate` kind — only one side is ever read at runtime, so a conflicting pair on the TS-DSL authoring path is now a build-time error instead of a silently-ignored declaration.

  **Breaking:** `upsert()` now requires a transaction-capable executor (`IdbRuntime`, via `createIdbClient`/`createAutoMigratingIdbClient`) unconditionally, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations. `upsert()` previously kept a non-atomic fallback for a bare `IdbQueryExecutor` (no `.transaction()`) — that fallback couldn't run `onUpdate` referential-action enforcement, so it's been removed rather than special-cased around. The plan-level `IdbUpsertAst` type is also removed (it was only ever produced by that fallback).

## 0.4.0

### Minor Changes

- [#211](https://github.com/prisma-idb/prisma-idb/pull/211) [`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Add `@default(...)` and bare `@updatedAt` support to the IDB family's PSL interpreter: literal defaults, `now()`, `uuid()`/`uuid(7)`, `cuid()`, and `autoincrement()` (mapped to IndexedDB's native auto-incrementing keys). Fields with an `onCreate` default — including `temporal.updatedAt()` from the previous release — are now correctly optional in `create()`'s input type, not just the primary key.

## 0.3.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fix `openAndUpgrade` not rejecting when batched marker writes fail mid-upgrade, which left callers hanging indefinitely instead of surfacing the error. Apply multi-space migrations within a single transaction. Expose `writeMarkers`, `renderMigrationTs`, and `decodeJsonRecord` from the browser-safe runtime/migration export surfaces.

## 0.2.0

## 0.1.2

## 0.1.1

### Patch Changes

- [#195](https://github.com/prisma-idb/prisma-idb/pull/195) [`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - add README files to all packages

## 0.1.0

### Minor Changes

- Initial release of the @prisma-next-idb family — a ground-up rewrite using the Prisma extension framework with ContractSpace-driven runtime, replacing the manifest-based generator approach.
