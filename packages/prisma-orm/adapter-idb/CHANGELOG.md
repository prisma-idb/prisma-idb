# @prisma-idb/adapter-idb

## 0.16.0

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.16.0
  - @prisma-idb/driver-idb@0.16.0

## 0.15.1

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.15.1
  - @prisma-idb/driver-idb@0.15.1

## 0.15.0

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.15.0
  - @prisma-idb/driver-idb@0.15.0

## 0.14.1

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.14.1
  - @prisma-idb/driver-idb@0.14.1

## 0.14.0

### Minor Changes

- [#356](https://github.com/prisma-idb/prisma-idb/pull/356) [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Evaluate list comparisons by element codec and reject unsupported list predicates before scanning.

### Patch Changes

- Updated dependencies [[`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806)]:
  - @prisma-idb/target-idb@0.14.0
  - @prisma-idb/driver-idb@0.14.0

## 0.13.0

### Patch Changes

- [#343](https://github.com/prisma-idb/prisma-idb/pull/343) [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Use field codec metadata for exact numeric Decimal equality, membership and range evaluation. Validate numeric Decimal filter operands and preserve text semantics for string operators.

- [#342](https://github.com/prisma-idb/prisma-idb/pull/342) [`5d109cb`](https://github.com/prisma-idb/prisma-idb/commit/5d109cb0411f600362210960bd77e4fd441e4060) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Carry canonical filter values and sort specifications through lowering so middleware can distinguish structured row closures. Preserve sort field priority and directions.

- [#344](https://github.com/prisma-idb/prisma-idb/pull/344) [`21821d3`](https://github.com/prisma-idb/prisma-idb/commit/21821d3b7209f811c836617214be78ad508ee251) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Preserve SQL unknown results for nullable comparisons through `and`, `or`, and `not`. Negative filters now exclude null and absent fields unless an explicit null check admits them. Membership lists follow SQL null semantics, while empty lists and explicit null checks keep their existing behavior.

- [#346](https://github.com/prisma-idb/prisma-idb/pull/346) [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build on Prisma 8 `8.0.0-rc.18`. No behavior change.

- Updated dependencies [[`e9c8575`](https://github.com/prisma-idb/prisma-idb/commit/e9c8575f2e7692121d5acc2d4abe6b9f73719ab6), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`15f6f9a`](https://github.com/prisma-idb/prisma-idb/commit/15f6f9a365d3b7c59c26556f5a42a27d28037901), [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`d3c16a2`](https://github.com/prisma-idb/prisma-idb/commit/d3c16a2cd8fc72c4c73a6f88032152e24c7cb5b0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`9c91ff5`](https://github.com/prisma-idb/prisma-idb/commit/9c91ff5d1baa1bf43541d66e0c649d712c0f93fa), [`d46f768`](https://github.com/prisma-idb/prisma-idb/commit/d46f76881756c69e6ffa835d64ed903c4b59f4cb), [`8dafeac`](https://github.com/prisma-idb/prisma-idb/commit/8dafeacf1e7d3a70d97ab4e167d9b2a0837b414f), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3)]:
  - @prisma-idb/driver-idb@0.13.0
  - @prisma-idb/target-idb@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [[`ef3cfac`](https://github.com/prisma-idb/prisma-idb/commit/ef3cfac839a45353b5df68d4569b0c2effe45f2a), [`7bf9398`](https://github.com/prisma-idb/prisma-idb/commit/7bf9398f141a0f14f5f9146aff69c50250eff850)]:
  - @prisma-idb/driver-idb@0.12.0
  - @prisma-idb/target-idb@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [[`79e3121`](https://github.com/prisma-idb/prisma-idb/commit/79e3121ed740224b9e1a5b2d721654e83cfa966c)]:
  - @prisma-idb/driver-idb@0.11.0
  - @prisma-idb/target-idb@0.11.0

## 0.10.0

### Patch Changes

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`a4fd04b`](https://github.com/prisma-idb/prisma-idb/commit/a4fd04b06cae21eee2ad2d2d02dcb98793725839) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Document the codec registry constructor parameter as the extension point for non-identity field codecs.

- Updated dependencies [[`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb), [`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb)]:
  - @prisma-idb/driver-idb@0.10.0
  - @prisma-idb/target-idb@0.10.0

## 0.9.1

### Patch Changes

- [#259](https://github.com/prisma-idb/prisma-idb/pull/259) [`8775088`](https://github.com/prisma-idb/prisma-idb/commit/877508838881c9f0e77222458628475d7ffd7a57) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Tidy the filter evaluator and correct docs. No behavior change.

  - Type the filter evaluator's operator as `IdbFilterOp`.
  - Describe `lower()` as the passthrough it is. The docs claimed it encodes field values.

- Updated dependencies [[`9ae224d`](https://github.com/prisma-idb/prisma-idb/commit/9ae224d3a576a273bbcccb4ba5bc13d922e8c91d), [`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375)]:
  - @prisma-idb/driver-idb@0.9.1
  - @prisma-idb/target-idb@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f)]:
  - @prisma-idb/target-idb@0.9.0
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

### Patch Changes

- Updated dependencies [[`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b), [`1f885dd`](https://github.com/prisma-idb/prisma-idb/commit/1f885dd0c24fa3fb42d23cc1539997915f264288)]:
  - @prisma-idb/target-idb@0.8.0
  - @prisma-idb/driver-idb@0.8.0

## 0.7.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds compound primary keys and compound secondary indexes. `@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` (PSL) and the equivalent TS-DSL `keyPath`/`IndexDef.keyPath` arrays now map directly to IndexedDB array `keyPath`s (`createObjectStore(name, { keyPath: [...] })` / `createIndex(name, [...])`). Previously `@@id([...])` was rejected with a claim that IndexedDB doesn't support compound keys, which is not true, so schemas with join tables or composite natural keys couldn't target the IDB family at all. Default compound index names join the member fields (`byUserId_effectiveFrom`-style), and schema diffing/verification and DDL emission are array-aware.

  `client-idb` builds and compares keys through shared helpers (`extractKeyFromRow`, `keyEquals`, `keyToken`), so compound keys work across `findUnique`, `update`, `delete`, `upsert`, cascades and `include()`. `keyEquals`/`keyToken` also compare `Date` and binary keys by value (including inside compound keys) rather than by reference. `CreateInput` now only makes the primary key optional when something actually fills it: a single-field `@default(autoincrement())` key (IndexedDB's key generator) or a key with its own `@default` such as `uuid()`/`cuid()`. A plain `@id` with no default, and every compound-key member without its own `@default`, is now required, since IndexedDB can't generate those keys and `create()` would otherwise fail at runtime with a `DataError`. Compound and `multiEntry` indexes are deliberately not used for single-field equality acceleration; accelerating them is left to the query planner.

  **Breaking (`client-idb`):** `getKeyPath` now throws when a model has no `storage.keyPath` instead of silently falling back to `"id"`, which used to mask malformed contracts.

  `sync-server` doesn't support compound-key models yet; `createSyncServer` now says so explicitly (and how to work around it) instead of reporting a generic "not a string keyPath" error.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fixes filters and sorting on `DateTime` and `Bytes` fields that aren't indexed. Values read back from IndexedDB are fresh objects, so the in-memory filter's `===` never matched two equal dates: `where({ createdAt: date })`, `eq` and `in` returned nothing, and `neq` returned the matching rows. The same query on a key or an indexed field worked, because it went through a key range. Filters now compare values the way IndexedDB compares keys, so the result no longer depends on whether a field is indexed.

  `orderBy` had the same problem. Equal dates never tied, so a second `orderBy` field was never used to break the tie. Sorting now follows IndexedDB's key order, with `null` last (first when descending).

  `target-idb/runtime` now exports the shared comparison helpers: `compareFieldValues`, `fieldValuesEqual`, `fieldValueToken`, `isValidIdbKey`, `keyEquals` and `keyToken`. `client-idb` still re-exports `keyEquals` and `keyToken`.

- Updated dependencies [[`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e), [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2)]:
  - @prisma-idb/target-idb@0.7.0
  - @prisma-idb/driver-idb@0.7.0

## 0.6.1

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/driver-idb@0.6.1
  - @prisma-idb/target-idb@0.6.1

## 0.6.0

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/target-idb@0.6.0
  - @prisma-next-idb/driver-idb@0.6.0

## 0.5.0

### Minor Changes

- [#213](https://github.com/prisma-idb/prisma-idb/pull/213) [`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Closes out the three ADR 009 referential-action follow-ups: recursive (multi-hop) `onDelete` cascade, `onUpdate` referential actions (`@relation(onUpdate: ...)`, defaulting to `cascade`), and `setDefault` support backed by a new `IdbModelStorage.fieldDefaults`/`ModelDef.fieldDefaults` map of literal `@default(...)` values. `update()`/`updateAll()`/`updateCount()`/`upsert()` now enforce `cascade`/`setNull`/`setDefault`/`restrict`/`noAction` the same way delete already did, including transitive multi-hop propagation with cycle-safe recursion.

  Also adds `defineContract` validation rejecting a relation and its reciprocal both declaring the same `onDelete`/`onUpdate` kind — only one side is ever read at runtime, so a conflicting pair on the TS-DSL authoring path is now a build-time error instead of a silently-ignored declaration.

  **Breaking:** `upsert()` now requires a transaction-capable executor (`IdbRuntime`, via `createIdbClient`/`createAutoMigratingIdbClient`) unconditionally, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations. `upsert()` previously kept a non-atomic fallback for a bare `IdbQueryExecutor` (no `.transaction()`) — that fallback couldn't run `onUpdate` referential-action enforcement, so it's been removed rather than special-cased around. The plan-level `IdbUpsertAst` type is also removed (it was only ever produced by that fallback).

### Patch Changes

- Updated dependencies [[`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09)]:
  - @prisma-next-idb/target-idb@0.5.0
  - @prisma-next-idb/driver-idb@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25)]:
  - @prisma-next-idb/target-idb@0.4.0
  - @prisma-next-idb/driver-idb@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32)]:
  - @prisma-next-idb/target-idb@0.3.0
  - @prisma-next-idb/driver-idb@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/target-idb@0.2.0
  - @prisma-next-idb/driver-idb@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`d7b767b`](https://github.com/prisma-idb/prisma-idb/commit/d7b767b74dd113f9f8758ef7718c0272a8ddc247)]:
  - @prisma-next-idb/driver-idb@0.1.2
  - @prisma-next-idb/target-idb@0.1.2

## 0.1.1

### Patch Changes

- [#195](https://github.com/prisma-idb/prisma-idb/pull/195) [`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - add README files to all packages

- Updated dependencies [[`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78)]:
  - @prisma-next-idb/driver-idb@0.1.1
  - @prisma-next-idb/target-idb@0.1.1

## 0.1.0

### Minor Changes

- Initial release of the @prisma-next-idb family — a ground-up rewrite using the Prisma extension framework with ContractSpace-driven runtime, replacing the manifest-based generator approach.

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/driver-idb@0.1.0
  - @prisma-next-idb/target-idb@0.1.0
