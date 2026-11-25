---
"@prisma-idb/target-idb": patch
---

A `Json` value can contain `null`, strings, booleans, finite numbers, dense arrays, and plain objects of those values. The list declaration controls whether a `Json[]` element itself can be `null`. Omit object properties you would otherwise set to `undefined`. Writes reject undefined properties and array elements so IndexedDB and sync see the same members. Arrays must have an element at every index and cannot carry a `toJSON` property. Convert values such as `Date`, `BigInt`, and bytes to your application’s JSON representation before writing them. The nesting limit is 1000 arrays or objects. Shared references are allowed. Their repeated expansion may account for up to one million values, object properties and UTF-16 code units in strings and property names. A `Json[]` row with legacy non-JSON elements fails `$push` and `$addToSet`. Replace the list with valid JSON values before appending to it again.
