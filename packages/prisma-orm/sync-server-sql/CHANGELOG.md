# @prisma-idb/sync-server-sql

## 0.5.0

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

### Patch Changes

- [#242](https://github.com/prisma-idb/prisma-idb/pull/242) [`43be273`](https://github.com/prisma-idb/prisma-idb/commit/43be2738366dcaf2b34517fc9c32af36db844c7e) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Pushes for the same scope can no longer make a pull skip changelog rows. Each push now takes a transaction-scoped Postgres advisory lock for its scope around the `Changelog` insert, and draws the new UUID v7 id strictly above the scope's current highest id, read under that lock. Previously two concurrent pushes could commit out of id order, and two app servers in the same millisecond (or one with a lagging clock) could draw a smaller id after a larger one had committed; a client whose cursor had passed the larger id then never saw the other row. Different scopes don't contend, and there is no wire or type change. Pushes now require the default READ COMMITTED transaction isolation level: the scope's highest id is read after the lock, and under REPEATABLE READ or SERIALIZABLE that read would use a snapshot taken before it, so `applyPush` fails the event (retryable, logged server-side) instead of risking a skipped row. The isolation check shares the advisory-lock query, avoiding an extra database round trip per new event; an unsupported transaction may wait for the lock before being rejected.

- Updated dependencies [[`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f)]:
  - @prisma-idb/target-idb@0.9.0
  - @prisma-idb/sync-server@0.6.0
  - @prisma-idb/sync-extension-idb@0.7.0

## 0.4.1

### Patch Changes

- [#244](https://github.com/prisma-idb/prisma-idb/pull/244) [`2dfd655`](https://github.com/prisma-idb/prisma-idb/commit/2dfd6558694e3490ca9fc213d2020b15543e52cf) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Stop push batches at the first retryable failure so dependent events stay pending for retry. Validate pull limits, pair ownership checks by changelog id, and document extensible outcome reasons.

## 0.4.0

### Minor Changes

- [#240](https://github.com/prisma-idb/prisma-idb/pull/240) [`0ac8195`](https://github.com/prisma-idb/prisma-idb/commit/0ac819588d4b8ea03c00dc8c372ee0dc9146b33f) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Add `applyPush` and `pull` to the SQL sync adapter, so a push or pull route is one call instead of a hand-written loop over `validatePush`, `applyPushEvent`, `buildPullQueries` and `resolvePullRecord`.

  - `applyPush({ events, scopeKey, maxBatchSize? })` validates and applies a whole batch in order and returns one result per event. A batch over `maxBatchSize` (default 1000) or with a repeated event id is rejected with `{ ok: false, reason }` before anything is applied.
  - `pull({ scopeKey, lastChangelogId?, limit? })` returns the next page of changes after an exclusive cursor (the last `changelogId`, a UUID v7 string), each re-authorized and resolved to its current record. A cursor that is not a UUID returns `{ ok: false, reason: "invalid-cursor" }`.
  - Pass `syncServer` to `createSqlSyncAdapter` to use them. Existing options and methods are unchanged.

### Patch Changes

- Updated dependencies [[`44b605f`](https://github.com/prisma-idb/prisma-idb/commit/44b605fb9c04373e43e3366dc538737646f2a624)]:
  - @prisma-idb/sync-server@0.5.0

## 0.3.0

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

- Updated dependencies [[`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b)]:
  - @prisma-idb/sync-server@0.4.0

## 0.2.6

### Patch Changes

- Updated dependencies [[`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2)]:
  - @prisma-idb/sync-server@0.3.2

## 0.2.5

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/sync-server@0.3.1

## 0.2.4

### Patch Changes

- Updated dependencies [[`46376ac`](https://github.com/prisma-idb/prisma-idb/commit/46376acf221ca837f0caadf616c45c285a2dc16a)]:
  - @prisma-next-idb/sync-server@0.3.0

## 0.2.3

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/sync-server@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/sync-server@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/sync-server@0.2.1

## 0.2.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Initial release. SQL execution adapter for `@prisma-next-idb/sync-server`: applies authorized push events and resolves pull records against a real Postgres/SQL ORM client, given `sync-server`'s ownership checks. Exposes `createSqlSyncAdapter` (bundling `applyPushEvent`, `toSyncPushPayload`, `resolvePullRecord`, `ormRootFor`, `checkAuthorization`, and `sqlGetKeyField` — the SQL-shaped `getKeyField` resolver for `sync-server`'s `createSyncServer`, since its default only understands IDB's flat `storage.keyPath`).

### Patch Changes

- Updated dependencies [[`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223)]:
  - @prisma-next-idb/sync-server@0.2.0
