---
"@prisma-idb/target-idb": minor
---

Add an optional `onTransformRecords` callback to `openAndUpgrade`. It runs in the upgrade transaction after each store transform, so callers can rewrite related data atomically. Call `onDone(error)` to abort the upgrade with that error.
