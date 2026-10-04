---
"@prisma-idb/target-idb": patch
---

Tidy codecs and migration planning. No behavior change.

- Move the `idb/bytes@1` base64 code into named helpers that build their lookup table once.
- Share one contract `storage` lookup between `contractToIdbSchema` and the storage hash extraction.
- Remove helper re-exports from the migration runner module that no package entry point used.
- Correct comments that described behavior the code no longer has.
