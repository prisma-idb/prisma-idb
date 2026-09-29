---
"@prisma-idb/family-idb": minor
"@prisma-idb/target-idb": minor
"@prisma-idb/client-idb": minor
---

Support Prisma enum blocks and enum-typed fields in PSL and `defineContract`, including optional fields, lists, defaults, generated literal-union types, and string-based filtering.

- The ORM client now rejects a create, update, or upsert that sets an enum field to an undeclared value, a non-array list value, or `null` on a required field. IndexedDB has no native enum type to reject these values.
