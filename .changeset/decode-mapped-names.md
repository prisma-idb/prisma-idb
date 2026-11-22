---
"@prisma-idb/family-idb": minor
---

PSL store and index names now decode escape sequences, as upstream Prisma does: `@@map("a\nb")` names the store with a newline, where it used to keep the backslash and `n` as written. The same applies to `name:` and `map:` on `@@index` and `@@unique`. A schema whose mapped names contain a backslash escape now gets a different store or index name, so plan a migration for it. Names without escapes are unchanged.
