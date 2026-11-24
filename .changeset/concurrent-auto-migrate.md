---
"@prisma-idb/target-idb": patch
"@prisma-idb/client-idb": patch
"@prisma-idb/driver-idb": patch
---

Concurrent auto-migrating opens of one database now each get the stores they asked for. Before, two calls could plan the same version, and the second resolved without its upgrade running. For example, a client with the sync extension could open a database without the sync stores and fail on its first sync.

- `openAndUpgrade` rejects with the new `IdbUpgradeSupersededError` when the open reaches the target version without running its upgrade.
- `createAutoMigratingIdbClient` then reads the markers again. It returns when every space it asked for is at its head, and otherwise plans the next upgrade from them, up to five attempts.
- A client whose connection a newer version closed, for example the first of two clients opened at the same time, opens a new connection on its next query or transaction. Before, every later query failed with `IdbExecuteError: IDB store "..." not found`.
- An upgrade whose blocked timeout already rejected no longer applies when it is unblocked later.
