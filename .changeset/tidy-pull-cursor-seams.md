---
"@prisma-idb/sync-extension-idb": patch
---

Internal cleanup of the pull path with no behavior change: `applyPull` decodes and validates a log in one place, the pull cursor lives in its own module, and the version-meta id is defined once.
