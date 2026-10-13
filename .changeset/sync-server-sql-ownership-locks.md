---
"@prisma-idb/sync-server-sql": patch
---

Lock PostgreSQL ownership rows before authorizing a push. Hold an exclusive lock on update and delete targets and shared locks on ownership and candidate-parent hops until commit. Concurrent parent reassignment or deletion can no longer invalidate a successful check. Pull and rejected-record reads remain lock-free; contention errors remain retryable.
