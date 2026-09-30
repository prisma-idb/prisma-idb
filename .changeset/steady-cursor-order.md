---
"@prisma-idb/sync-extension-idb": minor
---

Fix pull cursor ordering and let the cursor survive a reload.

- Changelog ids are compared numerically when both are digit strings. Previously `"10"` sorted before `"9"`, so the staleness guard could drop a newer log and `applyPull` could report a lower `lastChangelogId`.
- `createSyncWorker` accepts `getCursor` and `setCursor` to persist the pull cursor. `getCursor` runs once before the first pull; `setCursor` runs after a pull advances the cursor.
