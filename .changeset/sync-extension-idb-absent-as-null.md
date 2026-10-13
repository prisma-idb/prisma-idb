---
"@prisma-idb/sync-extension-idb": minor
---

Push a queued create with `null` for any nullable field it lacks, so a payload queued before the field existed passes the server's strict validation. Export `readForPush`.
