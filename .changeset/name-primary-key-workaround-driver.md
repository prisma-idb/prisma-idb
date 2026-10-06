---
"@prisma-idb/driver-idb": patch
---

Explain that primary keys are immutable. Advise handling dependent records before deleting and recreating a row, because restrictive relations can block the delete and cascading relations can delete dependents.
