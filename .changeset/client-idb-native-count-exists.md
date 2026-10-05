---
"@prisma-idb/client-idb": minor
---

Answer `count()` with the driver's native count when key ranges alone decide the match, without loading rows. Check foreign-key and `restrict` existence by reading one primary key instead of scanning the parent or child store. Filters that ranges cannot decide still read only the rows in the index range, then apply the full filter.

A `null` value in a `restrict` check now references no child rows.
