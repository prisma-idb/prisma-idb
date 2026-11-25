---
"@prisma-idb/family-idb": patch
---

`stripIdbExcludeAttributes`, which the sync server uses to load an IDB schema, now finds `@idb.exclude` and `@@idb.exclude` in the parser's syntax tree instead of matching text:

- Text that only looks like the attribute stays. Before, `@default("prefix @idb.exclude suffix")` became `@default("prefix suffix")` on the server, and a comment line that mentioned `@@idb.exclude` was deleted.
- A model with CRLF line endings no longer keeps a stray blank line where `@@idb.exclude` was.
- `@@idb.exclude` followed by another attribute on the same line, such as `@@map("a")`, no longer takes that attribute with it.
