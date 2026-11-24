---
"@prisma-idb/family-idb": patch
---

An empty relation name, `@relation("")`, counts as no name when PSL pairs a backrelation with its foreign key, as upstream Prisma does. A named backrelation that matches no relation name now reports `IDB_UNRESOLVED_BACKRELATION` with the names it found, instead of asking for an `@relation(fields: [...])` that already exists.
