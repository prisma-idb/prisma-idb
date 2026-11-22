---
"@prisma-idb/sync-extension-idb": patch
---

A pulled row for a model the client contract doesn't have, such as one a migration removed, now moves the cursor past it. Before, a page made only of such rows left the cursor in place, so the worker requested the same page on every cycle and never pulled later changes.
