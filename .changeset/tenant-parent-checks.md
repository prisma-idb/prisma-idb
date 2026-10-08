---
"@prisma-idb/sync-server": minor
---

Add automatic tenant parent checks so adapters can reject creates and updates that reference another user's rows. Reads and deletes retain access through any matching ownership path.
