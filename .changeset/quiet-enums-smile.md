---
"@prisma-idb/family-idb": minor
"@prisma-idb/target-idb": minor
"@prisma-idb/client-idb": minor
---

Support Prisma enum blocks and enum-typed fields in PSL and `defineContract`, including optional fields, lists, defaults, generated literal-union types, and string-based filtering.

- The ORM client now rejects a create, update, or upsert that sets an enum field to an undeclared value, a non-array list value, or `null` on a required field, matching Prisma Client's runtime validation.
- An attribute on an enum member (such as `USER @map("user")`) is now reported as a diagnostic instead of being silently ignored. Declare a stored value as `USER = "user"`.
