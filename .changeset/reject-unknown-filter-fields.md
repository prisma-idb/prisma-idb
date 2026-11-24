---
"@prisma-idb/client-idb": patch
---

A predicate on an unknown field throws `Model "<Model>" has no field "<field>"` in `where()`, a unique `upsert()` lookup, and nested relation criteria. Shorthand filters omit entries whose value is `undefined`. The query builder copies callback filter nodes so later edits to the original nodes cannot change which fields it tests.

**Breaking:** Nested `connect()` and `disconnect()` reject an explicitly empty criterion, including objects containing only `undefined` values. Use `disconnect()` or `disconnect([])` to detach all related rows. When the row being written holds the foreign key, pass exactly one criterion to `connect()` and omit criteria from `disconnect()`.
