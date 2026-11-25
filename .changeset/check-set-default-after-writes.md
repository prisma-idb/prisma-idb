---
"@prisma-idb/client-idb": patch
"@prisma-idb/sync-extension-idb": patch
---

`SetDefault` checks the resulting foreign key after the triggering write. Updating a parent's key to the default works, and writes with no matching children no longer fail over the default. An invalid default rolls back an ORM write or a pulled delete.
