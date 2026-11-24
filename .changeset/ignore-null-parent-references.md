---
"@prisma-idb/client-idb": patch
---

Referential actions skip parents whose referenced key contains a null field. A null foreign key references no parent, so deleting or updating such a parent leaves those children alone.
