---
"@prisma-idb/client-idb": minor
"@prisma-idb/family-idb": patch
---

`createAutoMigratingIdbClient` now applies every pending migration exactly as planned, destructive operations included. The `policy` option and the `MigrationPolicy` type are removed.

The old default refused destructive operations at runtime, so shipping a migration that dropped a store or an index (even just to change an index definition) stopped the app from opening for every user until the app passed `onDestructive: 'allow'`. Operations outside `allowedOperationClasses` were also skipped silently while the marker still advanced, leaving the database claiming a schema it didn't have.

The review now happens where the developer is: `prisma-idb migration plan` warns on stderr when a migration drops a store, listing each store whose records will be deleted.
