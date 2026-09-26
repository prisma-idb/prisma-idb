---
"@prisma-idb/target-idb": minor
"@prisma-idb/adapter-idb": patch
"@prisma-idb/client-idb": patch
---

Fixes filters and sorting on `DateTime` and `Bytes` fields that aren't indexed. Values read back from IndexedDB are fresh objects, so the in-memory filter's `===` never matched two equal dates: `where({ createdAt: date })`, `eq` and `in` returned nothing, and `neq` returned the matching rows. The same query on a key or an indexed field worked, because it went through a key range. Filters now compare values the way IndexedDB compares keys, so the result no longer depends on whether a field is indexed.

`orderBy` had the same problem. Equal dates never tied, so a second `orderBy` field was never used to break the tie. Sorting now follows IndexedDB's key order, with `null` last (first when descending).

`target-idb/runtime` now exports the shared comparison helpers: `compareFieldValues`, `fieldValuesEqual`, `fieldValueToken`, `isValidIdbKey`, `keyEquals` and `keyToken`. `client-idb` still re-exports `keyEquals` and `keyToken`.
