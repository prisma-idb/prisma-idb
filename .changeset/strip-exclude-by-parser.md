---
"@prisma-idb/family-idb": patch
---

`stripIdbExcludeAttributes`, which the sync server uses to load an IDB schema, now removes only real `@idb.exclude` and `@@idb.exclude` attributes. Before, it matched text, so `@default("prefix @idb.exclude suffix")` became `@default("prefix suffix")` on the server, and a matching comment line was removed.
