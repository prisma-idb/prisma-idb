---
"@prisma-idb/target-idb": patch
---

Register the PSL `date` tag for `idb/date`. It reads an ISO 8601 instant with a UTC offset, or a calendar date alone as midnight UTC, and stores the instant as `Date.prototype.toISOString()` writes it.
