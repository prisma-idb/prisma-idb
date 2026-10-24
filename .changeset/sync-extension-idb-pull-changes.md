---
"@prisma-idb/sync-extension-idb": minor
---

Report applied changelog entries in `pullcompleted` and `applyPull` results as `{ model, key, op }` changes. Use native IndexedDB keys, preserve compound-key order, and report ownership revocations as deletes. Skipped or rolled-back entries are excluded.

`PullCompletedEvent` and `ApplyPullResult` now require the `changes` field.
