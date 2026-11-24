---
"@prisma-idb/client-idb": patch
---

A predicate on an unknown field throws `Model "<Model>" has no field "<field>"` in `where()`, a unique `upsert()` lookup, and criteria used by nested relation writes. Shorthand filters omit entries whose value is `undefined`. The query builder copies callback filter nodes so later edits to the original nodes cannot change which fields it tests.

**Breaking:** Nested writes require a non-empty filter for each criterion they use. An object containing only `undefined` values counts as empty. For N:1 relations, `disconnect()` ignores supplied criteria and clears the foreign key, while `connect()` uses and validates only the first criterion. For 1:N relations, use `disconnect()` or `disconnect([])` to detach all related rows.
