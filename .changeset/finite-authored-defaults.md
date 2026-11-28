---
"@prisma-idb/family-idb": patch
---

Schema authoring rejects a non-finite `Float` default before writing the contract. This applies to PSL and to TypeScript `defaults` and `fieldDefaults`, including fields and models that a client projection excludes, so a client build refuses what a full build refuses. Use a finite number for the default.
