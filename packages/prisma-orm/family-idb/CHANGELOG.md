# @prisma-idb/family-idb

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
