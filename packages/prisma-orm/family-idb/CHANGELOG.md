# @prisma-idb/family-idb

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
