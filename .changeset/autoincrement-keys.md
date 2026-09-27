---
"@prisma-idb/driver-idb": patch
"@prisma-idb/sync-extension-idb": minor
---

`add` and `put` now return the generated key for `autoIncrement` stores. IndexedDB writes the generated key only into its stored copy, so a `create()` that left out an `autoIncrement` key used to return the row without it.

`createSyncIdbClient` now throws if a synced model's store uses `@default(autoincrement())`. Each device generates its own sequence, so records created offline on two devices get the same key and collide on the server. Use `@default(uuid())` or `@default(cuid())` for synced models, or leave the model out of `trackedModels`.
