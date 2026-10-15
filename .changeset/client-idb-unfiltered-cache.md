---
"@prisma-idb/client-idb": patch
---

Omit no-op row filters so unfiltered and orderBy-only reads reuse middleware cache entries.
