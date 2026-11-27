---
"@prisma-idb/client-idb": patch
"@prisma-idb/target-idb": patch
---

`createAutoMigratingIdbClient` now refuses to open when the app and an extension, or two extensions, use the same store name. This includes an upgrade in which one space drops a store and another creates a store with the same name. Before, one space's migration could drop or rewrite the other's store. Extension migrations also can't change the `_prisma_next_marker` store, which holds every space's migration marker.

The error names the store and both contract spaces. The client checks this each time it opens, against the extensions you pass and their pending migrations, before it creates or changes any store. It keeps no record of earlier owners, so it can't protect the stores of an extension you no longer pass.
