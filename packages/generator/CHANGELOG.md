# @prisma-idb/idb-client-generator

## 0.38.2

### Patch Changes

- [#393](https://github.com/prisma-idb/prisma-idb/pull/393) [`d1757bf`](https://github.com/prisma-idb/prisma-idb/commit/d1757bfe4e06fac85980a0afdc750116701ebdd8) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Attach the original error as `cause` when `createSyncServer` rejects a record validator and when contract publication fails and cannot be restored. Remove unused assignments, including one line in the generated client's push handler. Behavior is otherwise unchanged.

## 0.38.1

### Patch Changes

- [#199](https://github.com/prisma-idb/prisma-idb/pull/199) [`c5a1a05`](https://github.com/prisma-idb/prisma-idb/commit/c5a1a059fdc38f5d3284d0284aee7fb6211ccb7b) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Migrate release tooling from release-it to changesets for a unified release flow across the monorepo.
