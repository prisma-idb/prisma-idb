# @prisma-idb/family-idb

## 0.14.0

### Minor Changes

- [#351](https://github.com/prisma-idb/prisma-idb/pull/351) [`fb889c7`](https://github.com/prisma-idb/prisma-idb/commit/fb889c72e65a0b657019de41161fddb3c27e650f) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Validate PSL and TypeScript contract definitions with the same rules and diagnostic wording. TypeScript `defineContract` now throws the public `IdbContractError`, whose `diagnostics` array and message include every shared validation error with its `IDB_*` code. PSL diagnostics retain source spans.

  PSL now rejects optional enum lists (`Role[]?`), scalar lists (`String[]`), enum names that conflict with scalar types (`enum String`), unknown fields in `@@index` and `@@id`, and `@idb.exclude` on back-relation lists in client projections. A scalar field's `@unique` keeps its uniqueness when declared after `@relation`. Optional `temporal.updatedAt()?` fields are rejected. Shared errors use one wording on both authoring surfaces.

- [#353](https://github.com/prisma-idb/prisma-idb/pull/353) [`1c72afe`](https://github.com/prisma-idb/prisma-idb/commit/1c72afe900a07a13fecdc0e0e8b8f0f0f077f825) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add create-time defaults to `defineContract`, and index foreign keys by default.

  - A model's new `defaults` map takes `autoincrement()`, `now()`, `uuidv4()`, `uuidv7()`, `cuid2()` and `updatedAt()` from `@prisma-idb/family-idb/contract-ts`, or a literal value. They match PSL `@default(...)` and `@updatedAt`. A contract that uses them now carries an `executionHash`, and `create()` fills them as it does for PSL contracts. `fieldDefaults` still feeds only the `setDefault` referential action.
  - Every to-one relation (`N:1` and `1:1`) now indexes its foreign-key fields, for TypeScript contracts as well as PSL. A TypeScript contract with relations therefore gets a new `storageHash`, and its next migration adds one index per foreign key. A declared index named like the foreign-key field replaces the implicit one. To keep a relation unindexed, set `index: false` on it. PSL contracts keep their `storageHash` and have no opt-out. The one exception is a foreign-key field named like an inherited object key, such as `constructor`, which PSL previously left unindexed and now indexes.
  - A foreign-key field whose type IndexedDB cannot index, such as `Boolean`, is now rejected in TypeScript contracts, as it already was in PSL. Set `index: false` on the relation to keep it.

- [#356](https://github.com/prisma-idb/prisma-idb/pull/356) [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Support required scalar lists and empty-list defaults in PSL and TypeScript contracts. Reject list fields in primary keys and all indexes, including compound and multiEntry indexes.

### Patch Changes

- [#352](https://github.com/prisma-idb/prisma-idb/pull/352) [`8e55655`](https://github.com/prisma-idb/prisma-idb/commit/8e55655354a504f8b1458c09f909317fc41281f1) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Skip server-only scalar attribute binding in client projections while retaining exclusion validation for keys and indexes.

- [#355](https://github.com/prisma-idb/prisma-idb/pull/355) [`0154b39`](https://github.com/prisma-idb/prisma-idb/commit/0154b39c3e4f8795f5d96f9fd17d99b66e1586a4) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Document PSL and TypeScript contract authoring, execution defaults, structured diagnostics, and the foreign-key index migration path in the package README.

- [#348](https://github.com/prisma-idb/prisma-idb/pull/348) [`38db64a`](https://github.com/prisma-idb/prisma-idb/commit/38db64a4e0b004237e7672cb1f554669b74a1e92) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build `defineContract` contracts through a shared contract definition and builder. The contract, its hashes and its errors are unchanged.

- [#361](https://github.com/prisma-idb/prisma-idb/pull/361) [`3a15a46`](https://github.com/prisma-idb/prisma-idb/commit/3a15a466cb061de91222b510c57ec1893164368b) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Expose scalar types and PSL attribute specs through the IDB control family descriptor so editor tooling can resolve all nine supported scalars and discover attribute signatures, argument types, and documentation, including `@idb.exclude` and `@@idb.exclude`. Document the leading `// use prisma-8` directive required to select the Prisma 8 language server in the Prisma VS Code extension.

- [#354](https://github.com/prisma-idb/prisma-idb/pull/354) [`8940fdf`](https://github.com/prisma-idb/prisma-idb/commit/8940fdfff30365f56de0e1415557a75950dba065) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Expose the framework's PSL interpreter capability on the IDB contract source so editor tooling can report IDB diagnostics from cached schema text. Editor interpretation uses the same binder, definition, and validator pipeline as contract loading, with the configured projection and original source spans.

- [#352](https://github.com/prisma-idb/prisma-idb/pull/352) [`f18d6f5`](https://github.com/prisma-idb/prisma-idb/commit/f18d6f55b5d970bad89682fe3fc7292cf07f76ef) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Read PSL attribute arguments through the framework's attribute-spec binder instead of hand-written parsing. Valid schemas produce the same contract and hashes. A malformed attribute, such as `@@map(name)` or `@@id` without a field list, now fails with a binder diagnostic that points at the attribute.

- [#350](https://github.com/prisma-idb/prisma-idb/pull/350) [`017de3f`](https://github.com/prisma-idb/prisma-idb/commit/017de3f426b5b5c2f66765256b98d8ea36b5c594) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build PSL contracts through the shared contract definition and builder. Contract output, hashes, and diagnostic spans are unchanged.

- [#348](https://github.com/prisma-idb/prisma-idb/pull/348) [`a92b2f7`](https://github.com/prisma-idb/prisma-idb/commit/a92b2f709e3823efb88dd7e1b65bfbf36ad48fb1) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Preserve definition-controlled names such as `__proto__` in contract maps.

- [#353](https://github.com/prisma-idb/prisma-idb/pull/353) [`92d62c5`](https://github.com/prisma-idb/prisma-idb/commit/92d62c5c869303423185fd1a94a10fbbb33399d0) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Validate create-time default generators against their field types and codecs, rejecting timestamp helpers on non-DateTime fields and ID helpers on non-String fields.

- [#353](https://github.com/prisma-idb/prisma-idb/pull/353) [`b92a313`](https://github.com/prisma-idb/prisma-idb/commit/b92a3134c7243b1bcbb58756fe8b657e529f899e) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Report invalid TypeScript default values and foreign-key index name conflicts as contract diagnostics. Reuse a declared foreign-key index only when its keyPath indexes that field alone.

- Updated dependencies [[`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806)]:
  - @prisma-idb/target-idb@0.14.0

## 0.13.0

### Minor Changes

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Breaking change: include stored model and field shapes in IDB storage hashes. Re-emit contracts and plan a migration even when stores and indexes are unchanged. Field and enum declaration order, defaults, and documentation do not change the hash.

- [#305](https://github.com/prisma-idb/prisma-idb/pull/305) [`e4c317d`](https://github.com/prisma-idb/prisma-idb/commit/e4c317dfe5523909c721eeaa64d0c2254f13e084) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add an optional `onTransformRecords` hook to `IdbExtensionSpace`. An extension uses it to rewrite its own data when a migration transforms an app model's records.

- [#346](https://github.com/prisma-idb/prisma-idb/pull/346) [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build on Prisma 8 `8.0.0-rc.18`. The PSL reader uses the namespaced symbol table and reads enum members from block entries, so enum diagnostics point at the member when the provider passes the parsed `sources`. Contract sources declare `format`. The control instance implements `signSpaces` (a refusal, like `sign` before it) and `storageNameOf`. List fields are emitted as `many: { elementNullable: false }`, and execution defaults as `{ namespace, entry, field }`. `migration plan` passes `origin` and `statements` to the planner.

### Patch Changes

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Report all unfilled migration backfill slots during preflight, including slots on empty stores.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Generate record backfills and field removals in migration plans, including field data-loss warnings and explicit no-operation migrations.

- [#323](https://github.com/prisma-idb/prisma-idb/pull/323) [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Document the helper that reads the emitted contract's storage hash during preflight.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`82bc760`](https://github.com/prisma-idb/prisma-idb/commit/82bc760e592f4ad58cbd7eb6592bee1c4d4a276d) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Fail `prisma-idb migration preflight` when the emitted `contract.json` is not the target of the last migration. A contract change with no `migration plan` used to pass preflight, and the app then refused to open. The error names both hashes and the command to run.

- [#328](https://github.com/prisma-idb/prisma-idb/pull/328) [`75f8591`](https://github.com/prisma-idb/prisma-idb/commit/75f859119c1fefe9e1054e1e03f152d140d4ca5a) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Preserve the structured error code and explanation in migration preflight output so unfilled placeholder diagnostics include every slot name.

- [#305](https://github.com/prisma-idb/prisma-idb/pull/305) [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Preflight hand-authored record transforms in sequence with structural operations. Abort failed upgrades and report the original transform error.

- [#322](https://github.com/prisma-idb/prisma-idb/pull/322) [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Reject unsupported union fields in models and value objects during contract validation and record-shape construction. Errors name the owning model or value object and field.

- Updated dependencies [[`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`15f6f9a`](https://github.com/prisma-idb/prisma-idb/commit/15f6f9a365d3b7c59c26556f5a42a27d28037901), [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`d3c16a2`](https://github.com/prisma-idb/prisma-idb/commit/d3c16a2cd8fc72c4c73a6f88032152e24c7cb5b0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`9c91ff5`](https://github.com/prisma-idb/prisma-idb/commit/9c91ff5d1baa1bf43541d66e0c649d712c0f93fa), [`d46f768`](https://github.com/prisma-idb/prisma-idb/commit/d46f76881756c69e6ffa835d64ed903c4b59f4cb), [`8dafeac`](https://github.com/prisma-idb/prisma-idb/commit/8dafeacf1e7d3a70d97ab4e167d9b2a0837b414f), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3)]:
  - @prisma-idb/target-idb@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @prisma-idb/target-idb@0.11.0

## 0.10.0

### Minor Changes

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`f062370`](https://github.com/prisma-idb/prisma-idb/commit/f062370dbc0a87a54f1c80e2b2a6e7b5b1472a51) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Verify the replayed migration schema against the head contract snapshot during preflight. Fail with a readable diff on drift, or a recovery hint when the snapshot is missing, invalid, or does not match the head migration's target hash.

### Patch Changes

- Updated dependencies [[`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb)]:
  - @prisma-idb/target-idb@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375)]:
  - @prisma-idb/target-idb@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f)]:
  - @prisma-idb/target-idb@0.9.0

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

## 0.7.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds compound primary keys and compound secondary indexes. `@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` (PSL) and the equivalent TS-DSL `keyPath`/`IndexDef.keyPath` arrays now map directly to IndexedDB array `keyPath`s (`createObjectStore(name, { keyPath: [...] })` / `createIndex(name, [...])`). Previously `@@id([...])` was rejected with a claim that IndexedDB doesn't support compound keys, which is not true, so schemas with join tables or composite natural keys couldn't target the IDB family at all. Default compound index names join the member fields (`byUserId_effectiveFrom`-style), and schema diffing/verification and DDL emission are array-aware.

  `client-idb` builds and compares keys through shared helpers (`extractKeyFromRow`, `keyEquals`, `keyToken`), so compound keys work across `findUnique`, `update`, `delete`, `upsert`, cascades and `include()`. `keyEquals`/`keyToken` also compare `Date` and binary keys by value (including inside compound keys) rather than by reference. `CreateInput` now only makes the primary key optional when something actually fills it: a single-field `@default(autoincrement())` key (IndexedDB's key generator) or a key with its own `@default` such as `uuid()`/`cuid()`. A plain `@id` with no default, and every compound-key member without its own `@default`, is now required, since IndexedDB can't generate those keys and `create()` would otherwise fail at runtime with a `DataError`. Compound and `multiEntry` indexes are deliberately not used for single-field equality acceleration; accelerating them is left to the query planner.

  **Breaking (`client-idb`):** `getKeyPath` now throws when a model has no `storage.keyPath` instead of silently falling back to `"id"`, which used to mask malformed contracts.

  `sync-server` doesn't support compound-key models yet; `createSyncServer` now says so explicitly (and how to work around it) instead of reporting a generic "not a string keyPath" error.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`efcd242`](https://github.com/prisma-idb/prisma-idb/commit/efcd242c306b51fec92926c91cb5e38dc90488ef) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `createAutoMigratingIdbClient` now applies every pending migration exactly as planned, destructive operations included. The `policy` option and the `MigrationPolicy` type are removed.

  The old default refused destructive operations at runtime, so shipping a migration that dropped a store or an index (even just to change an index definition) stopped the app from opening for every user until the app passed `onDestructive: 'allow'`. Operations outside `allowedOperationClasses` were also skipped silently while the marker still advanced, leaving the database claiming a schema it didn't have.

  The review now happens where the developer is: `prisma-idb migration plan` warns on stderr when a migration drops a store, listing each store whose records will be deleted.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - - Running a hand-edited `migration.ts` to re-emit its artifacts now warns on stderr when the migration drops a store, like `prisma-idb migration plan` does. The warning text is exported from `@prisma-idb/target-idb/migration` as `deletedDataWarning`.
  - A migration whose marker write fails after the schema changes, for example on a quota or constraint error, now rejects with that error instead of a generic `AbortError`.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`4ae58cd`](https://github.com/prisma-idb/prisma-idb/commit/4ae58cd37a2dda9a20945bbeb48414de21ec864a) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `contract emit` warnings and errors about `@idb.exclude`, and the `migration plan --space` help text, no longer point at design documents. They now say what happened and what to do in the message itself.

- Updated dependencies [[`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef), [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9)]:
  - @prisma-idb/target-idb@0.7.0

## 0.6.1

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`88a3b5c`](https://github.com/prisma-idb/prisma-idb/commit/88a3b5cefb16e2940fd0b3a8d017aa41f117fbd1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Expose `prisma-idb` as the Prisma 8 IDB CLI command.

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/target-idb@0.6.1

## 0.6.0

### Minor Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `migration plan` now writes each distinct contract exactly once per migrations root, in a content-addressed store at `migrations/snapshots/<storageHash>/contract.{json,d.ts}` (ADR 240), instead of a `start-contract.*`/`end-contract.*` copy inside every migration package directory. Writes are write-if-absent (contract emission is already deterministic) and go through a temp-dir-then-rename so an interrupted write can never leave a partial store entry visible under its real hash. `snapshots` is now a reserved space id — `migration plan` refuses it, and the existing-package directory scan for extension spaces (which share `migrationsDir` directly, with no `app/` subdirectory) no longer mistakes the shared store for a migration package.

  **Breaking:** any tooling reading a migration package's `end-contract.json`/`end-contract.d.ts` directly needs to resolve `migrations/snapshots/<head migration's "to" hash>/contract.json` instead. `migration plan`'s head-consistency check is also simpler now: since the file's address _is_ the hash, the only failure mode left is a missing store entry, which now fails with its own explicit error message.

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `prisma-next-idb`'s CLI is rebuilt on `@prisma/cli-engine`'s command-definition primitives instead of a hand-rolled argument parser and output writer. The command surface is unchanged (`migration plan`, `migration contract-space`, `migration preflight`, same flags, same `--json` mode), but every command now goes through the same sink-collection and error-presentation path the engine gives every other ORM family's CLI, instead of writing to `process.stdout`/`process.stderr` directly.

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fixes two gaps found in review of the `@prisma/cli-engine` CLI shell:

  - `migration contract-space --out <path>` now resolves a relative path against the command's own `cwd`, matching `--contract`/`--migrations-dir` — previously it was passed straight to `writeFile` unresolved, which happened to work only because the shipped binary always has `cwd === process.cwd()`.
  - A contract-snapshot store entry that was written before its source `contract.d.ts` existed (see the existing warning) now gets `contract.d.ts` backfilled on the next `migration plan` for the same hash, instead of staying permanently `contract.json`-only.

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/target-idb@0.6.0

## 0.5.0

### Minor Changes

- [#213](https://github.com/prisma-idb/prisma-idb/pull/213) [`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Closes out the three ADR 009 referential-action follow-ups: recursive (multi-hop) `onDelete` cascade, `onUpdate` referential actions (`@relation(onUpdate: ...)`, defaulting to `cascade`), and `setDefault` support backed by a new `IdbModelStorage.fieldDefaults`/`ModelDef.fieldDefaults` map of literal `@default(...)` values. `update()`/`updateAll()`/`updateCount()`/`upsert()` now enforce `cascade`/`setNull`/`setDefault`/`restrict`/`noAction` the same way delete already did, including transitive multi-hop propagation with cycle-safe recursion.

  Also adds `defineContract` validation rejecting a relation and its reciprocal both declaring the same `onDelete`/`onUpdate` kind — only one side is ever read at runtime, so a conflicting pair on the TS-DSL authoring path is now a build-time error instead of a silently-ignored declaration.

  **Breaking:** `upsert()` now requires a transaction-capable executor (`IdbRuntime`, via `createIdbClient`/`createAutoMigratingIdbClient`) unconditionally, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations. `upsert()` previously kept a non-atomic fallback for a bare `IdbQueryExecutor` (no `.transaction()`) — that fallback couldn't run `onUpdate` referential-action enforcement, so it's been removed rather than special-cased around. The plan-level `IdbUpsertAst` type is also removed (it was only ever produced by that fallback).

### Patch Changes

- Updated dependencies [[`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09)]:
  - @prisma-next-idb/target-idb@0.5.0

## 0.4.0

### Minor Changes

- [#211](https://github.com/prisma-idb/prisma-idb/pull/211) [`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Add `@default(...)` and bare `@updatedAt` support to the IDB family's PSL interpreter: literal defaults, `now()`, `uuid()`/`uuid(7)`, `cuid()`, and `autoincrement()` (mapped to IndexedDB's native auto-incrementing keys). Fields with an `onCreate` default — including `temporal.updatedAt()` from the previous release — are now correctly optional in `create()`'s input type, not just the primary key.

### Patch Changes

- Updated dependencies [[`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25)]:
  - @prisma-next-idb/target-idb@0.4.0

## 0.3.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `prisma-next-idb` now resolves `--contract` and `--migrations-dir` from `prisma-next.config.ts` (via `@prisma-next/config-loader`, the same loader `prisma-next contract emit` uses) instead of hardcoded `src/lib/prisma/...` paths — projects with a non-default `contract.output` or `migrations.dir` no longer need to pass those flags on every invocation.

  The command surface is also restructured to mirror `prisma-next`'s own `<group> <verb>` shape:

  - `generate-baseline` and `generate-migration` are merged into a single auto-detecting `migration plan`, which picks greenfield vs. incremental based on whether the target space already has migration packages on disk (and prints a warning if it falls back to greenfield unexpectedly).
  - `generate-contract-space` is renamed to `migration contract-space`.
  - `preflight` is renamed to `migration preflight`.

  **Breaking:** the old flat command names (`generate-baseline`, `generate-migration`, `generate-contract-space`, `preflight`) no longer exist — update any `package.json` scripts or CI invocations to the `migration <verb>` form.

### Patch Changes

- Updated dependencies [[`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32)]:
  - @prisma-next-idb/target-idb@0.3.0

## 0.2.0

### Patch Changes

- [#205](https://github.com/prisma-idb/prisma-idb/pull/205) [`fcb4aca`](https://github.com/prisma-idb/prisma-idb/commit/fcb4aca55f17b3940a6737b3588256429b62ac3c) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Improved index utilisation on FK-targets and logical conditions; ported PSL parsing and schema verification to the updated @prisma-next APIs, and fixed schema-verify reporting the dotted contract path instead of the plain store name for index-level drift issues.

- Updated dependencies []:
  - @prisma-next-idb/target-idb@0.2.0

## 0.1.2

### Patch Changes

- [#201](https://github.com/prisma-idb/prisma-idb/pull/201) [`d7b767b`](https://github.com/prisma-idb/prisma-idb/commit/d7b767b74dd113f9f8758ef7718c0272a8ddc247) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Better create operations using separate "add" plan instead of overwriting with "put", improved migration hash validation, better onDelete referential actions handling, improved auto-migration client behavior

- Updated dependencies []:
  - @prisma-next-idb/target-idb@0.1.2

## 0.1.1

### Patch Changes

- [#195](https://github.com/prisma-idb/prisma-idb/pull/195) [`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - add README files to all packages

- Updated dependencies [[`52183bd`](https://github.com/prisma-idb/prisma-idb/commit/52183bdf47848eec028daae53b7328db945dbb78)]:
  - @prisma-next-idb/target-idb@0.1.1

## 0.1.0

### Minor Changes

- Initial release of the @prisma-next-idb family — a ground-up rewrite using the Prisma extension framework with ContractSpace-driven runtime, replacing the manifest-based generator approach.

### Patch Changes

- Updated dependencies []:
  - @prisma-next-idb/target-idb@0.1.0
