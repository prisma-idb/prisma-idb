---
"@prisma-idb/sync-extension-idb": minor
---

Make `worker.stop()` wait for the active cycle and suppress later cycle notifications. Await it before resetting on sign-out. Store the pull cursor in IndexedDB so it survives reloads and is cleared by `reset()`; remove `getCursor` and `setCursor` options.

Replace the sync migration history with one baseline that includes the meta store. Existing browser databases must be recreated. Resetting discards queued local edits, so sync them before upgrading when possible.
