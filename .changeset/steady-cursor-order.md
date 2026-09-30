---
"@prisma-idb/sync-extension-idb": minor
---

Fix pull cursor ordering and let the cursor survive a reload.

- Changelog ids are compared through one helper (`compareChangelogIds`) for both the pull cursor and the per-record staleness guard. The ids are UUID v7 strings, so string order is time order. Ordering is now centralised and covered by tests with real v7-shaped ids.
- `createSyncWorker` accepts `getCursor` and `setCursor` to persist the pull cursor. `getCursor` runs once before the first pull; `setCursor` runs after a pull advances the cursor.
