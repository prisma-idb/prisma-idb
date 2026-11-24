---
"@prisma-idb/family-idb": patch
---

`stripIdbExcludeAttributes` now finds attributes in the syntax tree rather than the symbol table, so it also removes `@idb.exclude` and `@@idb.exclude` from a model the symbol table drops, such as a duplicate model name or a block the parser recovered from after a syntax error. Before, those attributes stayed in the text and the SQL parser then rejected them. Text after non-ASCII characters is cut at the right place.
