---
"@prisma-idb/sync-extension-idb": minor
---

Add an `error` event carrying the thrown `Error` when a sync cycle fails. Preserve Error subclasses, stacks, and causes; wrap other thrown values in an Error with the original value as its cause, using a fallback message if string conversion fails. Isolate listener exceptions so all subscribers are notified and sync failures keep their original rejection.

Failed `forceSync()` calls now set status to `"error"` and emit the event while still rejecting with the original thrown value. Scheduled retries keep their existing backoff. Status values and `statuschange` payloads remain lowercase strings, so this introduces no breaking API change; the legacy generated worker's uppercase status object remains a separate API.
