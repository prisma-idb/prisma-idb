---
"@prisma-idb/target-idb": patch
---

Register the PSL `date` tag for `idb/date`. Like upstream's `mongo/date`, it reads an ISO 8601 instant with a UTC offset and stores it as `Date.prototype.toISOString()` writes it.
