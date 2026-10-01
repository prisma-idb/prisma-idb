---
"@prisma-idb/sync-extension-idb": minor
---

Fix pull cursor ordering and let the cursor survive a reload.

- Both the pull cursor and the per-record staleness guard compare UUID v7 changelog ids as plain strings. String order is time order, and ordering is covered by tests with real v7-shaped ids.
- `createSyncWorker` accepts `getCursor` and `setCursor` to persist the pull cursor. `getCursor` runs once before the first pull; `setCursor` runs after a pull advances the cursor.
