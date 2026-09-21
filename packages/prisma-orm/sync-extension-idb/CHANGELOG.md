# @prisma-idb/sync-extension-idb

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
