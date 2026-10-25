---
"@prisma-idb/sync-extension-idb": minor
---

Add the opt-in `syncOnReconnect` worker option to sync on browser online and visible-page events. Overlapping events share the active cycle, and stopping removes the listeners.
