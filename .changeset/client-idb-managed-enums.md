---
"@prisma-idb/client-idb": minor
---

Expose typed enums on managed handles without opening IndexedDB. Breaking: `createManagedIdbClient` now requires `enums` in its options; wrapped clients must expose the same enum type. Auto-migrating managed clients build the accessors automatically.
