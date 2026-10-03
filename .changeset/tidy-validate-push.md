---
"@prisma-idb/sync-server": patch
---

Internal cleanup of `validatePush` with no behavior change: the per-event key, record and ownership checks read as one short function, and the repeated validation-failure results are built once.
