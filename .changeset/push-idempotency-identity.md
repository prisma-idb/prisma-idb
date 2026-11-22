---
"@prisma-idb/sync-server-sql": patch
---

A pushed event is acknowledged as already applied only when the changelog records its id for the same scope, model, key and operation. Before, any changelog row with the same event id counted, so an event could be acknowledged, and dropped from the client's outbox, though the server never applied it. An id the changelog records for a different write now fails as non-retryable.
