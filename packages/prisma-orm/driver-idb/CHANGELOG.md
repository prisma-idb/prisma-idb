# @prisma-idb/driver-idb

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

## 0.7.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds key-only reads. A new `IdbKeysPlan` (`getKey(range)` for a single key, `getAllKeys(range, take)` otherwise) returns `{ key }` rows without deserializing records, with a new `KEYS_FAILED` error code. `client-idb` uses it for lookups that only ask "does a row with this primary key exist": foreign-key validation on create/update, the `setDefault` default-exists check, and `restrict` on shared-primary-key 1:1 relations. Lookups that need row values (cascades, `setNull`, upsert, non-primary-key targets, compound parent keys) are unchanged.

  Fixes a bug on the same path: a valid foreign key pointing at a `DateTime`-keyed parent was rejected with a false "FK violation", because two equal `Date` objects never compare `===`. Key-only lookups compare by IndexedDB key equality, so these now pass. The paths that later join on such a foreign key compare the same way now: referential actions (`cascade`, `restrict`, `setNull`, `setDefault`, `onUpdate` change detection) and `include()`. Without that, the child would have been silently orphaned when its parent was deleted, and never loaded by `include()`.

  `driver-idb` exports `IdbKeysPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"keys"` case. `sync-extension-idb` treats `keys` as an untracked read.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - The ORM `.count()` terminal and count-only `aggregate()` now use IndexedDB's native `count()` (`store.count(range)` / `index.count(range)`) through a new `IdbCountPlan`, instead of materializing every matching row just to measure the array. Native count is used only when the result cardinality is fully determined by the store/index and key range: no in-memory filter, no OR-union (which could double-count), and no `multiEntry` or compound index. `skip`/`take` are applied arithmetically to the native total. Everything else keeps the previous materialized behavior, so results are unchanged. Failures surface as `IdbExecuteError` with the new `COUNT_FAILED` code.

  `driver-idb` exports `IdbCountPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"count"` case. `sync-extension-idb` treats `count` as an untracked read.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `add` and `put` now return the generated key for `autoIncrement` stores. IndexedDB writes the generated key only into its stored copy, so a `create()` that left out an `autoIncrement` key used to return the row without it.

  `createSyncIdbClient` now throws if a synced model's store uses `@default(autoincrement())`. Each device generates its own sequence, so records created offline on two devices get the same key and collide on the server. Use `@default(uuid())` or `@default(cuid())` for synced models, or leave the model out of `trackedModels`.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - A request issued on a transaction that has already auto-committed (typically an `await` on something that isn't an IndexedDB request between two operations, see ADR 005/007) now fails with an `IdbExecuteError` coded `TRANSACTION_INACTIVE` and a message explaining the rule, instead of surfacing a bare `TransactionInactiveError`/`InvalidStateError` DOMException. The original exception is kept as `cause`. `IdbTransactionScope.execute()` no longer reports a finished transaction as `STORE_NOT_FOUND`, and an unrecognized plan kind (for example from a stale `driver-idb` build) now rejects with an error instead of never settling.

## 0.6.1

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

## 0.6.0

### Minor Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `IdbRuntime.execute()` is split into `query()` (returns rows, as an `AsyncIterableResult<Row>`) and `execute()` (returns `RuntimeStatementStats` — `{ affectedRows }` — for statements run purely for their side effects), mirroring the upstream `RuntimeCore` split. Every internal call site (`client-idb`'s store accessor, relation loader, mutation executor) has moved to `query()`.

  Alongside the split, `driver-idb`'s delete execution now walks a cursor instead of calling `store.delete(key)` directly, so both single-key and range (`deleteMany`) deletes echo back the rows they actually removed and report an accurate `affectedRows` count — previously delete always resolved with an empty result regardless of what was deleted.

  **Breaking:** anything constructing or calling `IdbRuntime` directly (not through `client-idb`'s generated client) must switch its read paths from `execute()` to `query()`; `execute()` now returns statement stats, not rows.

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

## 0.1.2

### Patch Changes

- [#201](https://github.com/prisma-idb/prisma-idb/pull/201) [`d7b767b`](https://github.com/prisma-idb/prisma-idb/commit/d7b767b74dd113f9f8758ef7718c0272a8ddc247) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Better create operations using separate "add" plan instead of overwriting with "put", improved migration hash validation, better onDelete referential actions handling, improved auto-migration client behavior

## 0.1.1

### Patch Changes

- [#195](https://github.com/prisma-idb/prisma-idb/pull/195) [`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - add README files to all packages

## 0.1.0

### Minor Changes

- Initial release of the @prisma-next-idb family — a ground-up rewrite using the Prisma extension framework with ContractSpace-driven runtime, replacing the manifest-based generator approach.
