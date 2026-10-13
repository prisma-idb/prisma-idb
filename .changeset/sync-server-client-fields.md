---
"@prisma-idb/sync-server": minor
---

Add `SyncServer.projectRecord(model, row)` to copy only top-level client-contract fields. The method preserves native values and throws for models absent from the client contract.
