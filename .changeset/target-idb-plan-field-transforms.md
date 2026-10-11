---
"@prisma-idb/target-idb": patch
---

Normalize Decimal literal defaults to stored strings and reject incompatible codec defaults. Plan literal-default backfills and removed fields from stored record shapes. Render these operations in migration files and warn about field data loss.

Allow compatible nested record changes without operations, including nullable additions, widened nullability, and enum additions. Keep unsafe nested changes rejected for authored transforms.
