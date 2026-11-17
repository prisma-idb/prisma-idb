---
"@prisma-idb/client-idb": patch
"@prisma-idb/target-idb": patch
---

Make `unique` optional in `IdbIndexDefinition` to match the canonicalised contract, which omits `unique: false`.
