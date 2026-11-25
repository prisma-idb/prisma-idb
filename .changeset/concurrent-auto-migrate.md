---
"@prisma-idb/target-idb": patch
"@prisma-idb/client-idb": patch
"@prisma-idb/driver-idb": patch
---

Concurrent auto-migrating opens of one database now each get the stores they asked for. Before, two calls could plan the same version, and the second resolved without its upgrade running. For example, a client with the sync extension could open a database without the sync stores and fail on its first sync.

- `openAndUpgrade` rejects with the new `IdbUpgradeSupersededError` when another connection reaches the target version or a newer version before its upgrade runs.
- `createAutoMigratingIdbClient` then reads the markers again. It returns when every space it asked for is at its head, and otherwise plans the next upgrade from them, up to five attempts.
- A client whose connection a newer version closed, for example the first of two clients opened at the same time, can open a new connection on its next query or transaction if the existing contract markers still match. A client must reopen with the current contract after an incompatible upgrade. An explicitly closed driver stays closed, and an invalidated driver does not recreate a deleted database.
- An upgrade whose blocked timeout already rejected no longer applies when it is unblocked later.
