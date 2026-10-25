# @prisma-idb/sync-server

## 0.9.0

### Minor Changes

- [#375](https://github.com/prisma-idb/prisma-idb/pull/375) [`f1d3134`](https://github.com/prisma-idb/prisma-idb/commit/f1d31345542f3a67eb7785592bdcf38ed14c23e9) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Document typed Postgres contract emission through `prisma-idb contract emit`. Import the emitted `.runtime.ts` module directly for sync setup without casting JSON to the generated contract type. Release with the companion sync packages' breaking transport update.

### Patch Changes

- Updated dependencies [[`f1d3134`](https://github.com/prisma-idb/prisma-idb/commit/f1d31345542f3a67eb7785592bdcf38ed14c23e9), [`e73e50a`](https://github.com/prisma-idb/prisma-idb/commit/e73e50ad12a97c63413b67a69772d7523e33bf4a)]:
  - @prisma-idb/family-idb@0.16.0
  - @prisma-idb/target-idb@0.16.0

## 0.8.4

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.15.1
  - @prisma-idb/family-idb@0.15.1

## 0.8.3

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.15.0
  - @prisma-idb/family-idb@0.15.0

## 0.8.2

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.14.1
  - @prisma-idb/family-idb@0.14.1

## 0.8.1

### Patch Changes

- Updated dependencies [[`8e55655`](https://github.com/prisma-idb/prisma-idb/commit/8e55655354a504f8b1458c09f909317fc41281f1), [`0154b39`](https://github.com/prisma-idb/prisma-idb/commit/0154b39c3e4f8795f5d96f9fd17d99b66e1586a4), [`38db64a`](https://github.com/prisma-idb/prisma-idb/commit/38db64a4e0b004237e7672cb1f554669b74a1e92), [`3a15a46`](https://github.com/prisma-idb/prisma-idb/commit/3a15a466cb061de91222b510c57ec1893164368b), [`8940fdf`](https://github.com/prisma-idb/prisma-idb/commit/8940fdfff30365f56de0e1415557a75950dba065), [`f18d6f5`](https://github.com/prisma-idb/prisma-idb/commit/f18d6f55b5d970bad89682fe3fc7292cf07f76ef), [`017de3f`](https://github.com/prisma-idb/prisma-idb/commit/017de3f426b5b5c2f66765256b98d8ea36b5c594), [`fb889c7`](https://github.com/prisma-idb/prisma-idb/commit/fb889c72e65a0b657019de41161fddb3c27e650f), [`1c72afe`](https://github.com/prisma-idb/prisma-idb/commit/1c72afe900a07a13fecdc0e0e8b8f0f0f077f825), [`a92b2f7`](https://github.com/prisma-idb/prisma-idb/commit/a92b2f709e3823efb88dd7e1b65bfbf36ad48fb1), [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806), [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806), [`92d62c5`](https://github.com/prisma-idb/prisma-idb/commit/92d62c5c869303423185fd1a94a10fbbb33399d0), [`b92a313`](https://github.com/prisma-idb/prisma-idb/commit/b92a3134c7243b1bcbb58756fe8b657e529f899e)]:
  - @prisma-idb/family-idb@0.14.0
  - @prisma-idb/target-idb@0.14.0

## 0.8.0

### Minor Changes

- [#346](https://github.com/prisma-idb/prisma-idb/pull/346) [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build on Prisma 8 `8.0.0-rc.18`. `sqlContractWithSync` creates the PSL binder and passes the target's default namespace. The Postgres sync config declares its `DateTime` constructor by codec only, because contract columns store a data type instead of a native type.

- [#326](https://github.com/prisma-idb/prisma-idb/pull/326) [`1304429`](https://github.com/prisma-idb/prisma-idb/commit/130442951ef302e18259e595847ee7a7887d741e) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add `SyncServer.projectRecord(model, row)` to copy only top-level client-contract fields. The method preserves native values and throws for models absent from the client contract.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Expose `SyncServer.clientStorageHash` from the emitted client contract so adapters can check whether a client is on the same contract.

- [#303](https://github.com/prisma-idb/prisma-idb/pull/303) [`0202333`](https://github.com/prisma-idb/prisma-idb/commit/020233367b702ea86103a4d7b0a5313185c87b72) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add automatic tenant parent checks so adapters can reject creates and updates that reference another user's rows. Reads and deletes retain access through any matching ownership path.

### Patch Changes

- Updated dependencies [[`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3), [`82bc760`](https://github.com/prisma-idb/prisma-idb/commit/82bc760e592f4ad58cbd7eb6592bee1c4d4a276d), [`75f8591`](https://github.com/prisma-idb/prisma-idb/commit/75f859119c1fefe9e1054e1e03f152d140d4ca5a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`e4c317d`](https://github.com/prisma-idb/prisma-idb/commit/e4c317dfe5523909c721eeaa64d0c2254f13e084), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`15f6f9a`](https://github.com/prisma-idb/prisma-idb/commit/15f6f9a365d3b7c59c26556f5a42a27d28037901), [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`d3c16a2`](https://github.com/prisma-idb/prisma-idb/commit/d3c16a2cd8fc72c4c73a6f88032152e24c7cb5b0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`9c91ff5`](https://github.com/prisma-idb/prisma-idb/commit/9c91ff5d1baa1bf43541d66e0c649d712c0f93fa), [`d46f768`](https://github.com/prisma-idb/prisma-idb/commit/d46f76881756c69e6ffa835d64ed903c4b59f4cb), [`8dafeac`](https://github.com/prisma-idb/prisma-idb/commit/8dafeacf1e7d3a70d97ab4e167d9b2a0837b414f), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3)]:
  - @prisma-idb/family-idb@0.13.0
  - @prisma-idb/target-idb@0.13.0

## 0.7.2

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.12.0
  - @prisma-idb/family-idb@0.12.0

## 0.7.1

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.11.0
  - @prisma-idb/family-idb@0.11.0

## 0.7.0

### Minor Changes

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`c1f6605`](https://github.com/prisma-idb/prisma-idb/commit/c1f6605f16647d86ee696bf90c77a66b6358d6b4) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Breaking: `SyncPushEvent` replaces the optional `wirePayload` with a required `wireKey`, the record's primary key in its JSON wire form. The ownership check uses it, and a call to `validatePush` without it is now a type error. Pass `wireKey: payload[keyField]` when your keys are strings.

### Patch Changes

- Updated dependencies [[`f062370`](https://github.com/prisma-idb/prisma-idb/commit/f062370dbc0a87a54f1c80e2b2a6e7b5b1472a51), [`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb)]:
  - @prisma-idb/family-idb@0.10.0
  - @prisma-idb/target-idb@0.10.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375)]:
  - @prisma-idb/target-idb@0.9.1
  - @prisma-idb/family-idb@0.9.1

## 0.6.1

### Patch Changes

- [#249](https://github.com/prisma-idb/prisma-idb/pull/249) [`b2e3619`](https://github.com/prisma-idb/prisma-idb/commit/b2e3619e49417e3cdf23528bc3cfda6d44c9f7d5) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Internal cleanup of `validatePush` with no behavior change: the per-event key, record and ownership checks read as one short function, and the repeated validation-failure results are built once.

## 0.6.0

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

- Updated dependencies [[`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f)]:
  - @prisma-idb/target-idb@0.9.0
  - @prisma-idb/family-idb@0.9.0

## 0.5.0

### Minor Changes

- [#240](https://github.com/prisma-idb/prisma-idb/pull/240) [`44b605f`](https://github.com/prisma-idb/prisma-idb/commit/44b605fb9c04373e43e3366dc538737646f2a624) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - The synthetic `Changelog` model now uses a UUID v7 id (`String @id @default(uuid(7))`) instead of an integer autoincrement. Ids sort correctly as plain strings, so the pull cursor stays an opaque string and no numeric comparison is needed. This changes the `Changelog` table: regenerate the contract and migrate (or recreate) any existing `Changelog` table, and reset stored pull cursors, which were integers.

## 0.4.0

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
  - @prisma-idb/family-idb@0.8.0

## 0.3.2

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds compound primary keys and compound secondary indexes. `@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` (PSL) and the equivalent TS-DSL `keyPath`/`IndexDef.keyPath` arrays now map directly to IndexedDB array `keyPath`s (`createObjectStore(name, { keyPath: [...] })` / `createIndex(name, [...])`). Previously `@@id([...])` was rejected with a claim that IndexedDB doesn't support compound keys, which is not true, so schemas with join tables or composite natural keys couldn't target the IDB family at all. Default compound index names join the member fields (`byUserId_effectiveFrom`-style), and schema diffing/verification and DDL emission are array-aware.

  `client-idb` builds and compares keys through shared helpers (`extractKeyFromRow`, `keyEquals`, `keyToken`), so compound keys work across `findUnique`, `update`, `delete`, `upsert`, cascades and `include()`. `keyEquals`/`keyToken` also compare `Date` and binary keys by value (including inside compound keys) rather than by reference. `CreateInput` now only makes the primary key optional when something actually fills it: a single-field `@default(autoincrement())` key (IndexedDB's key generator) or a key with its own `@default` such as `uuid()`/`cuid()`. A plain `@id` with no default, and every compound-key member without its own `@default`, is now required, since IndexedDB can't generate those keys and `create()` would otherwise fail at runtime with a `DataError`. Compound and `multiEntry` indexes are deliberately not used for single-field equality acceleration; accelerating them is left to the query planner.

  **Breaking (`client-idb`):** `getKeyPath` now throws when a model has no `storage.keyPath` instead of silently falling back to `"id"`, which used to mask malformed contracts.

  `sync-server` doesn't support compound-key models yet; `createSyncServer` now says so explicitly (and how to work around it) instead of reporting a generic "not a string keyPath" error.

- Updated dependencies [[`efcd242`](https://github.com/prisma-idb/prisma-idb/commit/efcd242c306b51fec92926c91cb5e38dc90488ef), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef), [`4ae58cd`](https://github.com/prisma-idb/prisma-idb/commit/4ae58cd37a2dda9a20945bbeb48414de21ec864a)]:
  - @prisma-idb/family-idb@0.7.0

## 0.3.1

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`88a3b5c`](https://github.com/prisma-idb/prisma-idb/commit/88a3b5cefb16e2940fd0b3a8d017aa41f117fbd1), [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/family-idb@0.6.1

## 0.3.0

### Minor Changes

- [#227](https://github.com/prisma-idb/prisma-idb/pull/227) [`46376ac`](https://github.com/prisma-idb/prisma-idb/commit/46376acf221ca837f0caadf616c45c285a2dc16a) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Replace `writeSqlSchemaWithSync` with `sqlContractWithSync`, a file-free version of the same transform: it decomposes the SQL family's `prismaContract()` into its component parts and substitutes an in-memory `load()`, so the sync `Changelog` model can be injected into a real server schema without ever writing a generated `.prisma` file to disk (see [prisma/orm#30115](https://github.com/prisma/orm/issues/30115)). It needs the core `defineConfig` wired by hand rather than a target's convenience wrapper (which only accepts a schema path for `contract`) — see the README for the full example.

  Also adds `@prisma-next-idb/sync-server/postgres`, a `defineConfig({ schema, output?, db?, migrations? })` facade that hides that wiring for the common Postgres case — mirroring the pattern `@prisma/orm-postgres/config` itself uses.

  **Breaking:** `writeSqlSchemaWithSync` is removed. Pre-1.0, so this ships as a minor bump rather than major.

  **Migration note:** if your `schema.prisma` still has a hand-authored `Changelog` model or `ChangeOperation` enum from before either helper existed, delete them — `sqlContractWithSync`/`@prisma-next-idb/sync-server/postgres` append both, and leaving your own declarations in place produces duplicate PSL declarations that fail contract generation.

## 0.2.3

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/family-idb@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09)]:
  - @prisma-next-idb/family-idb@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25)]:
  - @prisma-next-idb/family-idb@0.4.0

## 0.2.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Initial release. Server-side sync ownership DAG (ADR 014): given a `rootModel`, builds an authorization graph from the contract's relations at startup, then resolves per-record ownership checks for push validation and pull scoping. Transport- and storage-agnostic — `validatePush`/`buildPullQueries` return descriptions of what to check, and the caller executes them. Family-agnostic aside from one pluggable primary-key resolution point (`getKeyField`), defaulting to IDB's shape.

### Patch Changes

- Updated dependencies [[`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223)]:
  - @prisma-next-idb/family-idb@0.3.0
