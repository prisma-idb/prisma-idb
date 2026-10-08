---
"@prisma-idb/sync-extension-idb": minor
---

Let the server refuse a client on an outdated contract without losing data. `pushHandler` and `pullHandler` get a third argument, `context.contractFingerprint()`, to send with the request. Throw the new `ContractMismatchError` from a handler on HTTP 409: the worker keeps the pull cursor and unsent edits, emits `contractmismatch`, and retries with backoff.
