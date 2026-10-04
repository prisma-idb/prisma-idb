# @prisma-idb/client-idb

## 0.9.1

### Patch Changes

- [#259](https://github.com/prisma-idb/prisma-idb/pull/259) [`85ce498`](https://github.com/prisma-idb/prisma-idb/commit/85ce498e3be3261f3aec0d2294a94923bb823c15) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Simplify read-plan construction and relation result shaping. Remove unused internal helpers while preserving query and include behavior.

- [#259](https://github.com/prisma-idb/prisma-idb/pull/259) [`dc718d0`](https://github.com/prisma-idb/prisma-idb/commit/dc718d016a9659e8026950d04f6df1b513741521) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Share scalar update validation and transaction execution, group migration descriptor checks before database access, and remove unused private relation helpers. Preserve existing write behavior and public exports.

- Updated dependencies [[`8775088`](https://github.com/prisma-idb/prisma-idb/commit/877508838881c9f0e77222458628475d7ffd7a57), [`9ae224d`](https://github.com/prisma-idb/prisma-idb/commit/9ae224d3a576a273bbcccb4ba5bc13d922e8c91d), [`8775088`](https://github.com/prisma-idb/prisma-idb/commit/877508838881c9f0e77222458628475d7ffd7a57), [`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375)]:
  - @prisma-idb/adapter-idb@0.9.1
  - @prisma-idb/driver-idb@0.9.1
  - @prisma-idb/runtime-idb@0.9.1
  - @prisma-idb/target-idb@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f)]:
  - @prisma-idb/target-idb@0.9.0
  - @prisma-idb/adapter-idb@0.9.0
  - @prisma-idb/runtime-idb@0.9.0
  - @prisma-idb/driver-idb@0.9.0

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

### Patch Changes

- Updated dependencies [[`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b), [`1f885dd`](https://github.com/prisma-idb/prisma-idb/commit/1f885dd0c24fa3fb42d23cc1539997915f264288)]:
  - @prisma-idb/target-idb@0.8.0
  - @prisma-idb/driver-idb@0.8.0
  - @prisma-idb/adapter-idb@0.8.0
  - @prisma-idb/runtime-idb@0.8.0

## 0.7.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`efcd242`](https://github.com/prisma-idb/prisma-idb/commit/efcd242c306b51fec92926c91cb5e38dc90488ef) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `createAutoMigratingIdbClient` now applies every pending migration exactly as planned, destructive operations included. The `policy` option and the `MigrationPolicy` type are removed.

  The old default refused destructive operations at runtime, so shipping a migration that dropped a store or an index (even just to change an index definition) stopped the app from opening for every user until the app passed `onDestructive: 'allow'`. Operations outside `allowedOperationClasses` were also skipped silently while the marker still advanced, leaving the database claiming a schema it didn't have.

  The review now happens where the developer is: `prisma-idb migration plan` warns on stderr when a migration drops a store, listing each store whose records will be deleted.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`f48d1f9`](https://github.com/prisma-idb/prisma-idb/commit/f48d1f9c4b34625232c8f933171ffc84f9779854) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Foreign keys are now checked on every write that sets one.

  - **Compound foreign keys are checked as one tuple.** A plain write that set a compound foreign key used to throw "not supported". Now a single parent row must match every field. When an update sets only some fields of the key, the rest come from the row being updated. A key with any `null` field isn't checked, like SQL's `MATCH SIMPLE`.
  - **`setDefault` works on compound relations**, checking that one parent matches the whole default tuple. It used to throw.
  - **`createAll()` and `createCount()` check foreign keys.** They used to skip the check entirely. Rows that set a foreign key are now checked and inserted in one transaction, so one bad row writes nothing.
  - **`upsert()` checks foreign keys** on both its create and update branches. It used to check neither.
  - A foreign key that references a compound primary key is checked with a key-only lookup, in any field order.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds compound primary keys and compound secondary indexes. `@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` (PSL) and the equivalent TS-DSL `keyPath`/`IndexDef.keyPath` arrays now map directly to IndexedDB array `keyPath`s (`createObjectStore(name, { keyPath: [...] })` / `createIndex(name, [...])`). Previously `@@id([...])` was rejected with a claim that IndexedDB doesn't support compound keys, which is not true, so schemas with join tables or composite natural keys couldn't target the IDB family at all. Default compound index names join the member fields (`byUserId_effectiveFrom`-style), and schema diffing/verification and DDL emission are array-aware.

  `client-idb` builds and compares keys through shared helpers (`extractKeyFromRow`, `keyEquals`, `keyToken`), so compound keys work across `findUnique`, `update`, `delete`, `upsert`, cascades and `include()`. `keyEquals`/`keyToken` also compare `Date` and binary keys by value (including inside compound keys) rather than by reference. `CreateInput` now only makes the primary key optional when something actually fills it: a single-field `@default(autoincrement())` key (IndexedDB's key generator) or a key with its own `@default` such as `uuid()`/`cuid()`. A plain `@id` with no default, and every compound-key member without its own `@default`, is now required, since IndexedDB can't generate those keys and `create()` would otherwise fail at runtime with a `DataError`. Compound and `multiEntry` indexes are deliberately not used for single-field equality acceleration; accelerating them is left to the query planner.

  **Breaking (`client-idb`):** `getKeyPath` now throws when a model has no `storage.keyPath` instead of silently falling back to `"id"`, which used to mask malformed contracts.

  `sync-server` doesn't support compound-key models yet; `createSyncServer` now says so explicitly (and how to work around it) instead of reporting a generic "not a string keyPath" error.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds key-only reads. A new `IdbKeysPlan` (`getKey(range)` for a single key, `getAllKeys(range, take)` otherwise) returns `{ key }` rows without deserializing records, with a new `KEYS_FAILED` error code. `client-idb` uses it for lookups that only ask "does a row with this primary key exist": foreign-key validation on create/update, the `setDefault` default-exists check, and `restrict` on shared-primary-key 1:1 relations. Lookups that need row values (cascades, `setNull`, upsert, non-primary-key targets, compound parent keys) are unchanged.

  Fixes a bug on the same path: a valid foreign key pointing at a `DateTime`-keyed parent was rejected with a false "FK violation", because two equal `Date` objects never compare `===`. Key-only lookups compare by IndexedDB key equality, so these now pass. The paths that later join on such a foreign key compare the same way now: referential actions (`cascade`, `restrict`, `setNull`, `setDefault`, `onUpdate` change detection) and `include()`. Without that, the child would have been silently orphaned when its parent was deleted, and never loaded by `include()`.

  `driver-idb` exports `IdbKeysPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"keys"` case. `sync-extension-idb` treats `keys` as an untracked read.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - The ORM `.count()` terminal and count-only `aggregate()` now use IndexedDB's native `count()` (`store.count(range)` / `index.count(range)`) through a new `IdbCountPlan`, instead of materializing every matching row just to measure the array. Native count is used only when the result cardinality is fully determined by the store/index and key range: no in-memory filter, no OR-union (which could double-count), and no `multiEntry` or compound index. `skip`/`take` are applied arithmetically to the native total. Everything else keeps the previous materialized behavior, so results are unchanged. Failures surface as `IdbExecuteError` with the new `COUNT_FAILED` code.

  `driver-idb` exports `IdbCountPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"count"` case. `sync-extension-idb` treats `count` as an untracked read.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`d06e11e`](https://github.com/prisma-idb/prisma-idb/commit/d06e11eb8173d1ce3841a1430ec2c7f5c7b4fca0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Foreign-key checks now cover nested writes and defaults, so writes that used to succeed with a dangling reference now throw.

  - **Nested writes are checked.** A `create()` or `update()` with relation callbacks didn't check the row's own foreign keys, or those of the rows the callbacks created.
  - **Defaults are checked.** A foreign key filled in by `@default(...)` when the caller left it out, or by an `onUpdate` default, wasn't checked. The check now sees the row as it's written.
  - **Nested updates run `onUpdate` referential actions.** Changing a value that children refer to through a nested `update()` skipped them, so it neither cascaded nor restricted.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Referential actions now match what Postgres does with the same Prisma 8 schema, so a synced app's client and server allow the same changes.

  - **`onUpdate` defaults to `restrict`**, not `cascade`. Changing a value that children refer to now throws unless the relation declares `onUpdate: Cascade`, `SetNull` or `SetDefault`. Prisma 8 emits no `ON UPDATE` clause for an undeclared action, so Postgres rejects the change; the client used to cascade it locally and then fail on push.
  - **`noAction` behaves like `restrict`**, as `NO ACTION` does in SQL. It used to turn enforcement off, so the client would delete or change a parent that the server refused to, leaving dangling references locally.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Migrations now write their contract markers inside the same `upgradeneeded` transaction as their schema changes, so the two commit together or not at all. Previously the markers were written in a separate transaction after the upgrade. If the app was closed in between, the database kept the new schema with the old marker, and the next open replayed the migration.

  A failed upgrade now rejects with the error that caused it, instead of IndexedDB's generic `AbortError`. If the marker store is missing when markers need writing, the upgrade fails and rolls back. It used to log a warning and commit the schema without a marker. `writeMarkers` likewise rejects when the marker store is missing, instead of warning and resolving.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `include()` on a relation with a compound foreign key now joins on every field of the relation. It used to join on the first field only, so it attached the wrong rows whenever two parents shared that field's value, such as two members with the same handle in different orgs. A parent with a `null` in any of the fields gets no related rows. The join uses a key range when an index or the related primary key covers exactly the relation's fields, in any order.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fixes filters and sorting on `DateTime` and `Bytes` fields that aren't indexed. Values read back from IndexedDB are fresh objects, so the in-memory filter's `===` never matched two equal dates: `where({ createdAt: date })`, `eq` and `in` returned nothing, and `neq` returned the matching rows. The same query on a key or an indexed field worked, because it went through a key range. Filters now compare values the way IndexedDB compares keys, so the result no longer depends on whether a field is indexed.

  `orderBy` had the same problem. Equal dates never tied, so a second `orderBy` field was never used to break the tie. Sorting now follows IndexedDB's key order, with `null` last (first when descending).

  `target-idb/runtime` now exports the shared comparison helpers: `compareFieldValues`, `fieldValuesEqual`, `fieldValueToken`, `isValidIdbKey`, `keyEquals` and `keyToken`. `client-idb` still re-exports `keyEquals` and `keyToken`.

- Updated dependencies [[`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e), [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2)]:
  - @prisma-idb/target-idb@0.7.0
  - @prisma-idb/driver-idb@0.7.0
  - @prisma-idb/adapter-idb@0.7.0
  - @prisma-idb/runtime-idb@0.7.0

## 0.6.1

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/adapter-idb@0.6.1
  - @prisma-idb/driver-idb@0.6.1
  - @prisma-idb/runtime-idb@0.6.1
  - @prisma-idb/target-idb@0.6.1

## 0.6.0

### Minor Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `IdbRuntime.execute()` is split into `query()` (returns rows, as an `AsyncIterableResult<Row>`) and `execute()` (returns `RuntimeStatementStats` — `{ affectedRows }` — for statements run purely for their side effects), mirroring the upstream `RuntimeCore` split. Every internal call site (`client-idb`'s store accessor, relation loader, mutation executor) has moved to `query()`.

  Alongside the split, `driver-idb`'s delete execution now walks a cursor instead of calling `store.delete(key)` directly, so both single-key and range (`deleteMany`) deletes echo back the rows they actually removed and report an accurate `affectedRows` count — previously delete always resolved with an empty result regardless of what was deleted.

  **Breaking:** anything constructing or calling `IdbRuntime` directly (not through `client-idb`'s generated client) must switch its read paths from `execute()` to `query()`; `execute()` now returns statement stats, not rows.

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fixes `createAutoMigratingIdbClient` getting permanently stuck behind a hash-only "bridge" migration — one whose package has zero ops because only the contract's hashing changed, not its structure. The per-space marker write was previously gated on `pendingOps.length > 0`, so a space with an empty-ops package never wrote its marker forward to `targetHash`; since nothing changes on a retry either, the space could never converge. The marker now advances whenever it's behind `targetHash`, regardless of whether the migration itself had any ops to apply.

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/target-idb@0.6.0
  - @prisma-next-idb/driver-idb@0.6.0
  - @prisma-next-idb/adapter-idb@0.6.0
  - @prisma-next-idb/runtime-idb@0.6.0

## 0.5.0

### Minor Changes

- [#213](https://github.com/prisma-idb/prisma-idb/pull/213) [`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Closes out the three ADR 009 referential-action follow-ups: recursive (multi-hop) `onDelete` cascade, `onUpdate` referential actions (`@relation(onUpdate: ...)`, defaulting to `cascade`), and `setDefault` support backed by a new `IdbModelStorage.fieldDefaults`/`ModelDef.fieldDefaults` map of literal `@default(...)` values. `update()`/`updateAll()`/`updateCount()`/`upsert()` now enforce `cascade`/`setNull`/`setDefault`/`restrict`/`noAction` the same way delete already did, including transitive multi-hop propagation with cycle-safe recursion.

  Also adds `defineContract` validation rejecting a relation and its reciprocal both declaring the same `onDelete`/`onUpdate` kind — only one side is ever read at runtime, so a conflicting pair on the TS-DSL authoring path is now a build-time error instead of a silently-ignored declaration.

  **Breaking:** `upsert()` now requires a transaction-capable executor (`IdbRuntime`, via `createIdbClient`/`createAutoMigratingIdbClient`) unconditionally, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations. `upsert()` previously kept a non-atomic fallback for a bare `IdbQueryExecutor` (no `.transaction()`) — that fallback couldn't run `onUpdate` referential-action enforcement, so it's been removed rather than special-cased around. The plan-level `IdbUpsertAst` type is also removed (it was only ever produced by that fallback).

### Patch Changes

- Updated dependencies [[`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09)]:
  - @prisma-next-idb/target-idb@0.5.0
  - @prisma-next-idb/adapter-idb@0.5.0
  - @prisma-next-idb/runtime-idb@0.5.0
  - @prisma-next-idb/driver-idb@0.5.0

## 0.4.0

### Minor Changes

- [#211](https://github.com/prisma-idb/prisma-idb/pull/211) [`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Add `@default(...)` and bare `@updatedAt` support to the IDB family's PSL interpreter: literal defaults, `now()`, `uuid()`/`uuid(7)`, `cuid()`, and `autoincrement()` (mapped to IndexedDB's native auto-incrementing keys). Fields with an `onCreate` default — including `temporal.updatedAt()` from the previous release — are now correctly optional in `create()`'s input type, not just the primary key.

### Patch Changes

- Updated dependencies [[`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25)]:
  - @prisma-next-idb/target-idb@0.4.0
  - @prisma-next-idb/adapter-idb@0.4.0
  - @prisma-next-idb/runtime-idb@0.4.0
  - @prisma-next-idb/driver-idb@0.4.0

## 0.3.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Add `createManagedAutoIdbClient`, a convenience wrapper composing `createManagedIdbClient` with `createAutoMigratingIdbClient`. Threads `dbName`/`factory` once to both the managed wrapper and the underlying auto-migrating factory, instead of requiring callers to hand-compose the two (which meant writing `dbName` in two separate option bags with nothing tying them together — a drift between the two silently makes `reset()` delete the wrong database).

### Patch Changes

- Updated dependencies [[`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32)]:
  - @prisma-next-idb/target-idb@0.3.0
  - @prisma-next-idb/adapter-idb@0.3.0
  - @prisma-next-idb/runtime-idb@0.3.0
  - @prisma-next-idb/driver-idb@0.3.0

## 0.2.0

### Minor Changes

- [#205](https://github.com/prisma-idb/prisma-idb/pull/205) [`fcb4aca`](https://github.com/prisma-idb/prisma-idb/commit/fcb4aca55f17b3940a6737b3588256429b62ac3c) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Improved index utilisation on FK-targets and logical conditions; ported PSL parsing and schema verification to the updated @prisma-next APIs, and fixed schema-verify reporting the dotted contract path instead of the plain store name for index-level drift issues.

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/target-idb@0.2.0
  - @prisma-next-idb/driver-idb@0.2.0
  - @prisma-next-idb/adapter-idb@0.2.0
  - @prisma-next-idb/runtime-idb@0.2.0

## 0.1.2

### Patch Changes

- [#201](https://github.com/prisma-idb/prisma-idb/pull/201) [`d7b767b`](https://github.com/prisma-idb/prisma-idb/commit/d7b767b74dd113f9f8758ef7718c0272a8ddc247) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Better create operations using separate "add" plan instead of overwriting with "put", improved migration hash validation, better onDelete referential actions handling, improved auto-migration client behavior

- Updated dependencies [[`d7b767b`](https://github.com/prisma-idb/prisma-idb/commit/d7b767b74dd113f9f8758ef7718c0272a8ddc247)]:
  - @prisma-next-idb/runtime-idb@0.1.2
  - @prisma-next-idb/driver-idb@0.1.2
  - @prisma-next-idb/adapter-idb@0.1.2
  - @prisma-next-idb/target-idb@0.1.2

## 0.1.1

### Patch Changes

- [#195](https://github.com/prisma-idb/prisma-idb/pull/195) [`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - add README files to all packages

- Updated dependencies [[`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78)]:
  - @prisma-next-idb/adapter-idb@0.1.1
  - @prisma-next-idb/runtime-idb@0.1.1
  - @prisma-next-idb/driver-idb@0.1.1
  - @prisma-next-idb/target-idb@0.1.1

## 0.1.0

### Minor Changes

- Initial release of the @prisma-next-idb family — a ground-up rewrite using the Prisma extension framework with ContractSpace-driven runtime, replacing the manifest-based generator approach.

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/adapter-idb@0.1.0
  - @prisma-next-idb/runtime-idb@0.1.0
  - @prisma-next-idb/driver-idb@0.1.0
  - @prisma-next-idb/target-idb@0.1.0
