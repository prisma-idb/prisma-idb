---
"@prisma-idb/sync-extension-idb": patch
---

Internal cleanup with no behavior change: the outbox and version-meta store access goes through one raw-store module, the sync worker and client share one event emitter, and the executor builds outbox and version-meta writes in one place.
