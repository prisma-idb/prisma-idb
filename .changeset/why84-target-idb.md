---
"@prisma-idb/target-idb": minor
---

Guard migration/runtime marker compatibility with a cross-package integration test.

Remove `IdbMigrationControlDriver`, `IdbMigrationControlDriverDescriptor`, and `extractMigrationDriver` from `/control` and `/migration`. Use the stub driver from `@prisma-idb/driver-idb/control` in CLI configuration; migrations apply in the browser through the client factories.
