---
"@prisma-idb/family-idb": patch
---

Expose scalar types and PSL attribute specs through the IDB control family descriptor so editor tooling can resolve all nine supported scalars and discover attribute signatures, argument types, and documentation, including `@idb.exclude` and `@@idb.exclude`. Document the leading `// use prisma-8` directive required to select the Prisma 8 language server in the Prisma VS Code extension.
