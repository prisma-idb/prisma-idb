---
"@prisma-idb/sync-server-sql": patch
---

Stop push batches at the first retryable failure so dependent events stay pending for retry. Validate pull limits, pair ownership checks by changelog id, and document extensible outcome reasons.
