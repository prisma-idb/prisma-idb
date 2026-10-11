---
"@prisma-idb/target-idb": patch
---

Avoid checking every migration placeholder again for each record in a store walk. Migration application still rejects unfilled placeholders before applying operations.
