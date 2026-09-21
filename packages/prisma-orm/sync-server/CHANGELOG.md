# @prisma-idb/sync-server

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
