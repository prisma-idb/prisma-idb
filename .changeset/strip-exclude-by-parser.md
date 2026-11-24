---
"@prisma-idb/family-idb": patch
---

`stripIdbExcludeAttributes`, which the sync server uses to load an IDB schema, now removes only real `@idb.exclude` and `@@idb.exclude` attributes. It finds them in the syntax tree instead of matching text:

- Text that only looks like an attribute stays. Before, `@default("prefix @idb.exclude suffix")` became `@default("prefix suffix")` on the server, and a comment line that mentioned `@@idb.exclude` was removed.
- Attributes on a model the symbol table drops, such as a duplicate model name or a block the parser recovered from after a syntax error, are removed too. Before, they stayed in the text and the SQL parser rejected them.
- Text after non-ASCII characters is cut at the right place.
