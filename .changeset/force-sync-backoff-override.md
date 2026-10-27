---
"@prisma-idb/sync-extension-idb": minor
---

Add `forceSync({ overrideBackoff: true })` to retry pending outbox events immediately for one sync cycle. Calls without the option continue to respect event retry delays. Export `ForceSyncOptions` and clarify the default behavior.
