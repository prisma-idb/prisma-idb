---
"@prisma-idb/sync-extension-idb": patch
---

Throw an error for hand-built `update`, `updateAll` and `deleteAll` plans on a synced model. These plans were saved locally but never synced. The ORM's own methods are unaffected.
