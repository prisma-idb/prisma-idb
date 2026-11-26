---
"@prisma-idb/family-idb": patch
---

Breaking: two models with the same store name now fail with `IDB_DUPLICATE_STORE_NAME` in PSL and TypeScript. Before, the second model's store replaced the first, so `model Todo` and `model todo` compiled to one store with the wrong layout for one of them. Give each model its own store name, with `@@map` in PSL or `store` in TypeScript.

Moving a model to a new store name creates an empty store. If one model keeps the old store name, the planner can rewrite every row there to match that model's record shape. It cannot tell which rows belong to the model that moved. A changed key path or auto-increment setting prevents the planner from reusing the store, and a new unique index can fail on rows from the other model. In those cases, give both models new store names. The migration drops the old store and deletes its rows when neither model keeps its name.

A hand-authored `migration.ts` can rewrite rows within a store. Copying rows between stores requires app code. Run the recovery on each device before resuming normal writes.

1. Pause writes from the app, other tabs, and sync. Keep other tabs from starting an upgrade until the backup is saved. On a device still at the old migration, open the database without requesting a new version and export the rows you need and their primary keys before calling `createAutoMigratingIdbClient`. Identify each row's destination using your app's data. Save the backup and a pending-import flag somewhere the upgrade cannot touch, such as a separate IndexedDB database. Recover rows that were already overwritten from another source if you have one.
2. Apply the schema upgrade. Convert the saved rows to their destination models' record shapes and import them into the intended stores. If a model kept the old store, remove the moved model's old copies after verifying their import. Use the keys recorded in the backup to identify those copies.
3. Make the restore safe to rerun. On reload, check for a pending import even if the schema is already current. Clear the flag and resume writes only after verifying the restored rows and any cleanup. If you use the sync client to import, account for the new outbox events it queues.
