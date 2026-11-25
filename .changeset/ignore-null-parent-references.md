---
"@prisma-idb/client-idb": patch
---

Referential actions and nested `disconnect()` skip parents whose referenced key contains a null field. A foreign key with a null component references no parent, so these operations leave rows with null foreign keys alone.
