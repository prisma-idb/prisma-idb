---
"@prisma-idb/target-idb": patch
"@prisma-idb/client-idb": patch
---

Relation includes and `groupBy` now treat numerically equal `Decimal` spellings as one value, as foreign-key checks, filters and unique constraints already did. Before, a child with foreign key `"1.00"` passed the foreign-key check against parent `"1"` but its include returned `null`, and grouping `"1"`, `"1.0"` and `"1e0"` gave three groups. `@prisma-idb/target-idb/runtime` exports `decimalIdentityToken`, which gives each Decimal value one spelling for use as a key.

`groupBy` compares Decimal lists element by element, preserving their order and length. The group key keeps the first matching row's stored spellings.

Updating a referenced `Decimal` field to a numerically equal spelling, such as `"5"` to `"5.0"`, is no longer treated as a change to the key. Before, `onUpdate: Restrict` refused it when children existed and `onUpdate: Cascade` rewrote the children. Comparing very long Decimal text with long runs of zeros is also linear instead of quadratic.
