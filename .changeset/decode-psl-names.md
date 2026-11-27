---
"@prisma-idb/family-idb": patch
---

PSL now decodes escape sequences in `@@map`, `name:` and `map:` strings, as upstream Prisma does. For example, `@@map("a\\b")` now names the store `a\b`. Unknown escapes, such as `\q`, stay as written.

**Breaking:** a name that contains a valid escape sequence now decodes to a different name. The next migration you plan reflects the new name, and the browser applies it when the app opens. Depending on the schema, the migration can:

- **Index names:** drop the old index and create the new one. Records are kept.
- **Store names:** create an empty store under the new name and drop the old store with its records. If the new name is another model's old store name, the planner either reuses that store and its records or refuses the migration because the key paths differ.

To keep the old names, write each one as a PSL string again: escape every backslash as `\\` and every double quote as `\"`. For example, a store emitted as `a\nb` needs `@@map("a\\nb")`. Compare the emitted contract with the previous one, and review the planned migration for dropped stores, before you ship it.
