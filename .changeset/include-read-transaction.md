---
"@prisma-idb/client-idb": patch
---

Read the rows and every included relation of an `include()` query in one read-only IndexedDB transaction. Before, each relation was read in its own transaction, so a write that committed in between, for example from the sync worker or another tab, could produce a result that never existed: a parent whose children were already deleted, or a required to-one relation read as `null`. Inside `db.transaction()`, the read joins the open transaction as before. Runtime middleware no longer sees reads that use `include()`, the same as writes that run in a transaction scope.
