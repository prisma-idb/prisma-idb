---
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/sync-server": minor
---

`@@ignore` models never sync:

- `sync-extension-idb` never queues outbox events for an ignored model's rows, even when `trackedModels` lists the model or a cascade changes its rows.
- `sync-server` leaves ignored models out of the synced models, so a push for one is an unknown model, and refuses an ignored root model. An `@ignore` owning relation still counts as an ownership path.
