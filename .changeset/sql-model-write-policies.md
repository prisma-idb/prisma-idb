---
"@prisma-idb/sync-server-sql": minor
---

Add per-model `writePolicies` with operation and writable-field allowlists. Reject a forbidden push batch before any record or changelog writes and return HTTP 403 from the Fetch handlers. Enforce the same policy for lower-level single-event writes.
