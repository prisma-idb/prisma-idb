---
"@prisma-idb/family-idb": patch
---

Breaking: PSL store and index names now decode escape sequences, as upstream Prisma does. `@@map("a\nb")` names the store `a`, a newline, then `b`, where it used to keep the backslash and `n` as written. `"a\\b"` now gives one backslash instead of two. The same applies to `name:` and `map:` on `@@index` and `@@unique`. An unknown or incomplete escape, such as `\q` or `\u12`, stays as written. Names without a backslash are unchanged.

If a mapped name in your schema contains a backslash escape, its decoded name differs from the stored one:

- For an index, the next migration drops the old index and creates the renamed one.
- For a store, the next migration drops the old store with its records and creates an empty store under the decoded name. IndexedDB can't rename a store in place. To keep the existing store and its records, write the name so that it decodes to the old one: double each backslash, for example `@@map("a\\nb")` for a store named `a\nb`. Check the planned migration for a `dropObjectStoreOp` before you apply it.
