---
"@prisma-idb/runtime-idb": patch
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
"@prisma-idb/driver-idb": patch
---

The runtime now checks the database's contract marker before its first query or transaction, as Prisma 8's SQL runtime does, and again after another connection upgrades the database and the driver reopens. A missing marker logs a `CONTRACT.MARKER_MISSING` warning, and a marker for another contract logs `CONTRACT.MARKER_MISMATCH`. Queries still run. Before, a plain client queried a database it had never checked.

Clients now log the warning by default, including `createIdbClient` and `createSyncIdbClient` on a database that you migrated without prisma-idb. Auto-migrating clients write the marker first, so they warn only after another tab migrates the database to a different contract. Prisma 8's runtime drops these warnings unless you pass a `log` sink; this one goes to `console.warn`, because a missing marker in a browser app is usually a setup mistake.

Pass `verifyMarker: false` to `createIdbClient`, `createSyncIdbClient` or `createIdbRuntime` to skip the check. The check compares the `"app"` marker, which belongs to the client's own contract. Extension spaces, such as the sync stores, keep their own marker rows and are not compared.
