---
"@prisma-idb/target-idb": minor
"@prisma-idb/driver-idb": minor
"@prisma-idb/adapter-idb": minor
"@prisma-idb/runtime-idb": minor
"@prisma-idb/client-idb": minor
"@prisma-idb/family-idb": minor
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/sync-server": minor
"@prisma-idb/sync-server-sql": minor
---

Support Prisma `8.0.0-rc.12` (`prisma@8.0.0-rc.17`). The packages now depend on `@prisma/orm-framework` / `@prisma/orm-toolchain` `8.0.0-rc.12` and `@prisma/cli-engine` `0.6.1`.

- IDB codecs declare a `dataType`, and the IDB target registers those data types, so `prisma contract emit` works again.
- The PSL contract providers (`prismaIdbContract`, `sqlContractWithSync`) use the new multi-document parser API. Diagnostics point at the configured schema path.
- The `prisma-idb` CLI no longer imports the removed `finalizeConfig`. The config section now resolves `contract.output` / `migrations.dir` itself.
- To-one relations carry the `nullable` flag the emitter now requires. PSL derives it from the relation field (`User?`). `defineContract` derives it from the local FK fields and accepts an explicit `nullable` override.
- `contract.d.ts` types an index without a `unique` flag as `unique: false`.
- The sync server's Postgres `defineConfig` binds `DateTime` to the JS-`Date` codec (`pg/timestamptz-date@1`). rc.12's default Temporal codec needs a global `Temporal` that Node 24 does not provide, and IDB clients sync `Date`s. The column type is still `timestamptz`.
- `applyPushEvent` turns ISO strings on `DateTime` fields back into `Date`s before writing, because push payloads arrive as JSON.

Re-emitted contracts keep the same `storageHash`, so existing IndexedDB databases need no migration.
