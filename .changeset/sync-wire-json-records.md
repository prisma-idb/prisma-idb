---
"@prisma-idb/target-idb": minor
---

The runtime exports `encodeJsonRecord` and `encodeJsonFieldValue` alongside `decodeJsonRecord`. Record codecs process fields supplied by the record itself, so sparse patches may omit fields such as `toString`.

Writes and wire encoding now reject values inside `Json` and `Json[]` that cannot be represented in JSON. Convert Date, BigInt and binary values to your application's JSON representation before writing them.
