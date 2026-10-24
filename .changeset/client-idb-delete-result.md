---
"@prisma-idb/client-idb": patch
---

Return the deleted row from `delete(key)` and throw `PrismaClientKnownRequestError` with code `P2025` when the key is missing. Use a non-null return type and the same contract for referential-action deletes. Export the Prisma error class from the client and ORM entry points so callers can catch missing-record errors.
