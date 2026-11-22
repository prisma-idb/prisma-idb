---
"@prisma-idb/runtime-idb": patch
---

The runtime now checks the database's contract marker once, before its first query or transaction, as Prisma 8's SQL runtime does. A missing marker logs a `CONTRACT.MARKER_MISSING` warning, and a marker for another contract logs `CONTRACT.MARKER_MISMATCH`. Queries still run. Before, a plain client queried a database it had never checked. Pass `verifyMarker: false` to `createIdbRuntime` to skip the check.
