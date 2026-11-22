---
"@prisma-idb/target-idb": patch
"@prisma-idb/client-idb": patch
---

Concurrent auto-migrating opens of one database now each get the stores they asked for. Before, two calls could plan the same version, and the second resolved without its upgrade running. For example, a client with the sync extension could open a database without the sync stores and fail on its first sync.

- `openAndUpgrade` rejects with the new `IdbUpgradeSupersededError` when the open reaches the target version without running its upgrade.
- `createAutoMigratingIdbClient` then reads the markers again and plans from them, and it checks that every space is at its head before it returns.
- An upgrade whose blocked timeout already rejected no longer applies when it is unblocked later.
