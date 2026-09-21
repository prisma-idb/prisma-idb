# @prisma-idb/sync-server-sql

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
