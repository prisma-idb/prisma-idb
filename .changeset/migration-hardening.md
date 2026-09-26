---
"@prisma-idb/target-idb": minor
"@prisma-idb/family-idb": patch
---

- Running a hand-edited `migration.ts` to re-emit its artifacts now warns on stderr when the migration drops a store, like `prisma-idb migration plan` does. The warning text is exported from `@prisma-idb/target-idb/migration` as `deletedDataWarning`.
- A migration whose marker write fails after the schema changes, for example on a quota or constraint error, now rejects with that error instead of a generic `AbortError`.
