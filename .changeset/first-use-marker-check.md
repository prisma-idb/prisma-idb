---
"@prisma-idb/runtime-idb": patch
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
"@prisma-idb/driver-idb": patch
---

The runtime now checks the database's contract marker before its first query or transaction, as Prisma 8's SQL runtime does, and again after another connection upgrades the database and the driver reopens. A missing marker logs a `CONTRACT.MARKER_MISSING` warning, and a marker for another contract logs `CONTRACT.MARKER_MISMATCH`. Unreadable markers log `CONTRACT.MARKER_UNREADABLE`. A marker warning allows the operation to proceed. The check runs even when a middleware answers the query from its own cache. Before, a plain client queried a database it had never checked.

Clients now log the warning by default, including `createIdbClient` and `createSyncIdbClient` on a database that you migrated without prisma-idb. Auto-migrating clients write the marker first. If the driver refuses to reconnect after an incompatible upgrade, the marker check logs `CONTRACT.MARKER_UNREADABLE` and the operation also fails with the driver's reconnect error. Warnings go to `console.warn`.

Pass `verifyMarker: false` to `createIdbClient`, `createSyncIdbClient` or `createIdbRuntime` to skip the check. The check compares the `"app"` marker, which belongs to the client's own contract. Extension spaces, such as the sync stores, keep their own marker rows and are not compared.
