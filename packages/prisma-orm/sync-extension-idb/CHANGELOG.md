# @prisma-idb/sync-extension-idb

## 0.5.0

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

### Patch Changes

- Updated dependencies [[`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b), [`1f885dd`](https://github.com/prisma-idb/prisma-idb/commit/1f885dd0c24fa3fb42d23cc1539997915f264288)]:
  - @prisma-idb/target-idb@0.8.0
  - @prisma-idb/driver-idb@0.8.0
  - @prisma-idb/adapter-idb@0.8.0
  - @prisma-idb/runtime-idb@0.8.0
  - @prisma-idb/client-idb@0.8.0
  - @prisma-idb/family-idb@0.8.0

## 0.4.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `add` and `put` now return the generated key for `autoIncrement` stores. IndexedDB writes the generated key only into its stored copy, so a `create()` that left out an `autoIncrement` key used to return the row without it.

  `createSyncIdbClient` now throws if a synced model's store uses `@default(autoincrement())`. Each device generates its own sequence, so records created offline on two devices get the same key and collide on the server. Use `@default(uuid())` or `@default(cuid())` for synced models, or leave the model out of `trackedModels`.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds key-only reads. A new `IdbKeysPlan` (`getKey(range)` for a single key, `getAllKeys(range, take)` otherwise) returns `{ key }` rows without deserializing records, with a new `KEYS_FAILED` error code. `client-idb` uses it for lookups that only ask "does a row with this primary key exist": foreign-key validation on create/update, the `setDefault` default-exists check, and `restrict` on shared-primary-key 1:1 relations. Lookups that need row values (cascades, `setNull`, upsert, non-primary-key targets, compound parent keys) are unchanged.

  Fixes a bug on the same path: a valid foreign key pointing at a `DateTime`-keyed parent was rejected with a false "FK violation", because two equal `Date` objects never compare `===`. Key-only lookups compare by IndexedDB key equality, so these now pass. The paths that later join on such a foreign key compare the same way now: referential actions (`cascade`, `restrict`, `setNull`, `setDefault`, `onUpdate` change detection) and `include()`. Without that, the child would have been silently orphaned when its parent was deleted, and never loaded by `include()`.

  `driver-idb` exports `IdbKeysPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"keys"` case. `sync-extension-idb` treats `keys` as an untracked read.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - The ORM `.count()` terminal and count-only `aggregate()` now use IndexedDB's native `count()` (`store.count(range)` / `index.count(range)`) through a new `IdbCountPlan`, instead of materializing every matching row just to measure the array. Native count is used only when the result cardinality is fully determined by the store/index and key range: no in-memory filter, no OR-union (which could double-count), and no `multiEntry` or compound index. `skip`/`take` are applied arithmetically to the native total. Everything else keeps the previous materialized behavior, so results are unchanged. Failures surface as `IdbExecuteError` with the new `COUNT_FAILED` code.

  `driver-idb` exports `IdbCountPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"count"` case. `sync-extension-idb` treats `count` as an untracked read.

- Updated dependencies [[`efcd242`](https://github.com/prisma-idb/prisma-idb/commit/efcd242c306b51fec92926c91cb5e38dc90488ef), [`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e), [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994), [`f48d1f9`](https://github.com/prisma-idb/prisma-idb/commit/f48d1f9c4b34625232c8f933171ffc84f9779854), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`d06e11e`](https://github.com/prisma-idb/prisma-idb/commit/d06e11eb8173d1ce3841a1430ec2c7f5c7b4fca0), [`4ae58cd`](https://github.com/prisma-idb/prisma-idb/commit/4ae58cd37a2dda9a20945bbeb48414de21ec864a), [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2)]:
  - @prisma-idb/client-idb@0.7.0
  - @prisma-idb/family-idb@0.7.0
  - @prisma-idb/target-idb@0.7.0
  - @prisma-idb/driver-idb@0.7.0
  - @prisma-idb/adapter-idb@0.7.0
  - @prisma-idb/runtime-idb@0.7.0

## 0.3.2

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`88a3b5c`](https://github.com/prisma-idb/prisma-idb/commit/88a3b5cefb16e2940fd0b3a8d017aa41f117fbd1), [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/family-idb@0.6.1
  - @prisma-idb/adapter-idb@0.6.1
  - @prisma-idb/client-idb@0.6.1
  - @prisma-idb/driver-idb@0.6.1
  - @prisma-idb/runtime-idb@0.6.1
  - @prisma-idb/target-idb@0.6.1

## 0.3.1

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/client-idb@0.6.0
  - @prisma-next-idb/family-idb@0.6.0
  - @prisma-next-idb/target-idb@0.6.0
  - @prisma-next-idb/driver-idb@0.6.0
  - @prisma-next-idb/adapter-idb@0.6.0
  - @prisma-next-idb/runtime-idb@0.6.0

## 0.3.0

### Minor Changes

- [#213](https://github.com/prisma-idb/prisma-idb/pull/213) [`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Closes out the three ADR 009 referential-action follow-ups: recursive (multi-hop) `onDelete` cascade, `onUpdate` referential actions (`@relation(onUpdate: ...)`, defaulting to `cascade`), and `setDefault` support backed by a new `IdbModelStorage.fieldDefaults`/`ModelDef.fieldDefaults` map of literal `@default(...)` values. `update()`/`updateAll()`/`updateCount()`/`upsert()` now enforce `cascade`/`setNull`/`setDefault`/`restrict`/`noAction` the same way delete already did, including transitive multi-hop propagation with cycle-safe recursion.

  Also adds `defineContract` validation rejecting a relation and its reciprocal both declaring the same `onDelete`/`onUpdate` kind — only one side is ever read at runtime, so a conflicting pair on the TS-DSL authoring path is now a build-time error instead of a silently-ignored declaration.

  **Breaking:** `upsert()` now requires a transaction-capable executor (`IdbRuntime`, via `createIdbClient`/`createAutoMigratingIdbClient`) unconditionally, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations. `upsert()` previously kept a non-atomic fallback for a bare `IdbQueryExecutor` (no `.transaction()`) — that fallback couldn't run `onUpdate` referential-action enforcement, so it's been removed rather than special-cased around. The plan-level `IdbUpsertAst` type is also removed (it was only ever produced by that fallback).

### Patch Changes

- Updated dependencies [[`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09)]:
  - @prisma-next-idb/target-idb@0.5.0
  - @prisma-next-idb/family-idb@0.5.0
  - @prisma-next-idb/client-idb@0.5.0
  - @prisma-next-idb/adapter-idb@0.5.0
  - @prisma-next-idb/runtime-idb@0.5.0
  - @prisma-next-idb/driver-idb@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25)]:
  - @prisma-next-idb/target-idb@0.4.0
  - @prisma-next-idb/family-idb@0.4.0
  - @prisma-next-idb/client-idb@0.4.0
  - @prisma-next-idb/adapter-idb@0.4.0
  - @prisma-next-idb/runtime-idb@0.4.0
  - @prisma-next-idb/driver-idb@0.4.0

## 0.2.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Initial release. Browser-side outbox sync extension for the Prisma Next IDB family: wraps an IDB ORM client to atomically write outbox events alongside every mutation, then provides a `SyncWorker` that pushes those events to a server and pulls remote changes back, plus a managed IDB client for singleton/race-safe access and retryable outbox event handling with `localChangePending` tracking. `createManagedAutoSyncIdbClient` composes the managed wrapper with `createAutoMigratingSyncIdbClient` in one call, so `dbName` only needs to be written once.

  This package previously shipped with no test coverage. Its first suite (unit + real-browser multi-tab Playwright) surfaced and fixed three bugs that were live in the previous unreleased build: relation traversal always threw, the push query built an invalid boolean `IDBKeyRange`, and pull unconditionally skipped every log entry.

### Patch Changes

- Updated dependencies [[`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32), [`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223), [`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32)]:
  - @prisma-next-idb/client-idb@0.3.0
  - @prisma-next-idb/family-idb@0.3.0
  - @prisma-next-idb/target-idb@0.3.0
  - @prisma-next-idb/adapter-idb@0.3.0
  - @prisma-next-idb/runtime-idb@0.3.0
  - @prisma-next-idb/driver-idb@0.3.0
