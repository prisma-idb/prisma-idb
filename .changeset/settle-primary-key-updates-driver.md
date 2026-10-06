---
"@prisma-idb/driver-idb": patch
---

Reject primary-key-changing updates consistently instead of hanging or duplicating rows. Route synchronous cursor failures to operation errors, abort failed transactions, and settle pending scope operations on abort.
