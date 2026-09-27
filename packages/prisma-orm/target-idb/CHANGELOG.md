# @prisma-idb/target-idb

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
