---
"@prisma-idb/target-idb": minor
---

The runtime exports `encodeJsonRecord` and `encodeJsonFieldValue` alongside `decodeJsonRecord`. Record codecs process fields supplied by the record itself, so sparse patches may omit fields such as `toString`.

Wire encoding of `Json` values refuses the same values that `Json` writes refuse and writes negative zero as zero, as JSON serialization does.
