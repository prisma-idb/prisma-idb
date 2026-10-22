# @prisma-idb/sync-server-sql

## 0.8.0

### Minor Changes

- [#364](https://github.com/prisma-idb/prisma-idb/pull/364) [`f60e74d`](https://github.com/prisma-idb/prisma-idb/commit/f60e74daa5b0dd08b7a84b2d3a3c38fa6fe2e04a) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add fetch-compatible push and pull HTTP handlers, usable with Hono, that validate requests and map contract mismatches to HTTP 409.

### Patch Changes

- Updated dependencies [[`f60e74d`](https://github.com/prisma-idb/prisma-idb/commit/f60e74daa5b0dd08b7a84b2d3a3c38fa6fe2e04a)]:
  - @prisma-idb/sync-extension-idb@0.9.0
  - @prisma-idb/target-idb@0.14.1
  - @prisma-idb/sync-server@0.8.2

## 0.7.1

### Patch Changes

- Updated dependencies [[`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806)]:
  - @prisma-idb/target-idb@0.14.0
  - @prisma-idb/sync-extension-idb@0.8.1
  - @prisma-idb/sync-server@0.8.1

## 0.7.0

### Minor Changes

- [#346](https://github.com/prisma-idb/prisma-idb/pull/346) [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build on Prisma 8 `8.0.0-rc.18`. Ownership row locks cast the key to the Postgres type of the column's data type, which replaces the removed `nativeType`. `@prisma/orm-postgres` is now an optional peer dependency, needed only on Postgres.

- [#303](https://github.com/prisma-idb/prisma-idb/pull/303) [`02bb4ab`](https://github.com/prisma-idb/prisma-idb/commit/02bb4ab270842be7c3e11df543c7fe0e3ac721c9) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Reject creates and updates that reference another user's tenant parents. Require checked foreign keys to target single-field parent primary keys and have no defaults.

- [#326](https://github.com/prisma-idb/prisma-idb/pull/326) [`1304429`](https://github.com/prisma-idb/prisma-idb/commit/130442951ef302e18259e595847ee7a7887d741e) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Project pull responses and rejected-push reconciliation records to client-contract fields after authorization and before wire encoding. Server-only fields are no longer returned.

  Behavior change: the lower-level `adapter.resolvePullRecord` now requires the `syncServer` option and returns a rejected promise without it, consistent with `applyPush` and `pull`. Pass the `createSyncServer` result when constructing the adapter.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Refuse clients on a different contract. `pull` and `applyPush` take `clientStorageHash` and return `{ ok: false, reason: "contract-mismatch", expected }` before reading or writing anything when it is missing or differs from the server's. Answer HTTP 409. The check is on by default; pass `contractCheck: "off"` to `createSqlSyncAdapter` to opt out. Existing routes must now forward the storage hash.

- [#297](https://github.com/prisma-idb/prisma-idb/pull/297) [`e709eb9`](https://github.com/prisma-idb/prisma-idb/commit/e709eb978ce1ce35c757fa22e1cd6f15e6720e92) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Classify push write failures by SQLSTATE and return the server's row with every rejection.

  - A write that fails with SQLSTATE class 22 (data exception) or 23 (integrity constraint violation) is now `retryable: false`. Before, any database error was retryable, so a unique violation made the client retry forever. Connection loss, timeouts, deadlocks and errors with no SQLSTATE stay retryable.
  - A retry that collides with its own first request (SQLSTATE `23505` on an event the server already applied) now returns `success: true`.
  - `applyPush` adds `record` to each non-retryable failure: the row's current state for the caller, or `null` if it is deleted or not theirs. The ownership check is the same one `pull` runs. It is absent when the key cannot be decoded or the model is unknown. A client that does not know `record` ignores it.

### Patch Changes

- [#327](https://github.com/prisma-idb/prisma-idb/pull/327) [`07a595e`](https://github.com/prisma-idb/prisma-idb/commit/07a595e0dc04cefae9201f824b722a5e2475f3c1) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Lock PostgreSQL ownership rows before authorizing a push. Hold an exclusive lock on update and delete targets and shared locks on ownership and candidate-parent hops until commit. Concurrent parent reassignment or deletion can no longer invalidate a successful check. Pull and rejected-record reads remain lock-free; contention errors remain retryable.

- Updated dependencies [[`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`7967a1c`](https://github.com/prisma-idb/prisma-idb/commit/7967a1c6dd487caddc9b34e5486e5b1070353baf), [`9147392`](https://github.com/prisma-idb/prisma-idb/commit/91473928c7b9797a5496c495582071da020a6ca2), [`65e24b1`](https://github.com/prisma-idb/prisma-idb/commit/65e24b1d592abf53a3392eac90d07a049d387e08), [`7b236da`](https://github.com/prisma-idb/prisma-idb/commit/7b236da0361a22f2a2a8caa243d0a6f59e3d0686), [`d2e86ab`](https://github.com/prisma-idb/prisma-idb/commit/d2e86abe2cf48e49cdf67eafc936698b893dd78d), [`7b625b0`](https://github.com/prisma-idb/prisma-idb/commit/7b625b047e7fc2ea9bb559422be1bb098d15af4c), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`c320d17`](https://github.com/prisma-idb/prisma-idb/commit/c320d17c13d760544087195391f551b526f6c7cf), [`1304429`](https://github.com/prisma-idb/prisma-idb/commit/130442951ef302e18259e595847ee7a7887d741e), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`15f6f9a`](https://github.com/prisma-idb/prisma-idb/commit/15f6f9a365d3b7c59c26556f5a42a27d28037901), [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`d3c16a2`](https://github.com/prisma-idb/prisma-idb/commit/d3c16a2cd8fc72c4c73a6f88032152e24c7cb5b0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`9c91ff5`](https://github.com/prisma-idb/prisma-idb/commit/9c91ff5d1baa1bf43541d66e0c649d712c0f93fa), [`d46f768`](https://github.com/prisma-idb/prisma-idb/commit/d46f76881756c69e6ffa835d64ed903c4b59f4cb), [`8dafeac`](https://github.com/prisma-idb/prisma-idb/commit/8dafeacf1e7d3a70d97ab4e167d9b2a0837b414f), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3), [`0202333`](https://github.com/prisma-idb/prisma-idb/commit/020233367b702ea86103a4d7b0a5313185c87b72)]:
  - @prisma-idb/sync-extension-idb@0.8.0
  - @prisma-idb/sync-server@0.8.0
  - @prisma-idb/target-idb@0.13.0

## 0.6.2

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/sync-extension-idb@0.7.5
  - @prisma-idb/target-idb@0.12.0
  - @prisma-idb/sync-server@0.7.2

## 0.6.1

### Patch Changes

- Updated dependencies [[`79e3121`](https://github.com/prisma-idb/prisma-idb/commit/79e3121ed740224b9e1a5b2d721654e83cfa966c)]:
  - @prisma-idb/sync-extension-idb@0.7.4
  - @prisma-idb/target-idb@0.11.0
  - @prisma-idb/sync-server@0.7.1

## 0.6.0

### Minor Changes

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`334a6d9`](https://github.com/prisma-idb/prisma-idb/commit/334a6d906cfb5b6a57a9894aa4d9c90952a24269) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Breaking: the root export no longer includes the free functions `applyPush`, `pull`, `applyPushEvent`, `toSyncPushPayload`, `resolvePullRecord`, `checkAuthorization`, `resolveRootKeyViaPath` and `ormRootFor`, or the `OrmRoot` type. Use the methods on `createSqlSyncAdapter` instead. `sqlGetKeyField`, the default limits and the adapter's types stay.

  Each pushed event is now decoded once, whether it arrives through `applyPush` or the adapter's `applyPushEvent`.

  The adapter now passes `wireKey` to `validatePush`, matching the `SyncPushEvent` change in `@prisma-idb/sync-server`.

### Patch Changes

- Updated dependencies [[`9edee99`](https://github.com/prisma-idb/prisma-idb/commit/9edee9972fe801922f406e4acc93a81454e1a0b1), [`003b273`](https://github.com/prisma-idb/prisma-idb/commit/003b273e820c9c1e035f48b03e1f43ffd1a64934), [`c1f6605`](https://github.com/prisma-idb/prisma-idb/commit/c1f6605f16647d86ee696bf90c77a66b6358d6b4), [`36e524d`](https://github.com/prisma-idb/prisma-idb/commit/36e524d41c0f4dbdda5a1e280e5c071dfe0a66f6), [`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb)]:
  - @prisma-idb/sync-extension-idb@0.7.3
  - @prisma-idb/sync-server@0.7.0
  - @prisma-idb/target-idb@0.10.0

## 0.5.2

### Patch Changes

- [#259](https://github.com/prisma-idb/prisma-idb/pull/259) [`84e3ca3`](https://github.com/prisma-idb/prisma-idb/commit/84e3ca3cd8481dad91aa94bfc95b4dcd59d995b8) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Internal cleanup with no behavior change: `applyPush` decodes wire events in a separate step, and push and pull share one `reviveWireKey` helper for wire-form keys.

- Updated dependencies [[`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375), [`df2dc4b`](https://github.com/prisma-idb/prisma-idb/commit/df2dc4b8c41a97fce327d019a6d124781cdea2d4)]:
  - @prisma-idb/target-idb@0.9.1
  - @prisma-idb/sync-extension-idb@0.7.2
  - @prisma-idb/sync-server@0.6.2

## 0.5.1

### Patch Changes

- [#249](https://github.com/prisma-idb/prisma-idb/pull/249) [`45eb49c`](https://github.com/prisma-idb/prisma-idb/commit/45eb49cd7d435fa527d3e362582192764dec9094) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Internal cleanup of push and pull with no behavior change: wire value encoding and revival live in one module, the `Changelog` table is read and written through one module, and the pull files are named after what they export.

- Updated dependencies [[`7a61070`](https://github.com/prisma-idb/prisma-idb/commit/7a61070ff8b2cbc6d3135c34b8f28fe9e6d15516), [`b2e3619`](https://github.com/prisma-idb/prisma-idb/commit/b2e3619e49417e3cdf23528bc3cfda6d44c9f7d5)]:
  - @prisma-idb/sync-extension-idb@0.7.1
  - @prisma-idb/sync-server@0.6.1

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
