---
"@prisma-idb/target-idb": minor
---

Remove `IdbMigrationControlDriver`, `IdbMigrationControlDriverDescriptor`, and `extractMigrationDriver` from `/control` and `/migration`. Use the stub driver from `@prisma-idb/driver-idb/control` in CLI configuration; migrations apply in the browser through the client factories.
