---
"@prisma-idb/runtime-idb": patch
---

Prevent filtered and ordered reads from sharing incorrect middleware cache entries. Hash structured closure identity and use fresh hashes for opaque closures whose captured state cannot be determined.
