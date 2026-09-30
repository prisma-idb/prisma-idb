---
"@prisma-idb/sync-server-sql": minor
---

Add `applyPush` and `pull` to the SQL sync adapter, so a push or pull route is one call instead of a hand-written loop over `validatePush`, `applyPushEvent`, `buildPullQueries` and `resolvePullRecord`.

- `applyPush({ events, scopeKey, maxBatchSize? })` validates and applies a whole batch in order and returns one result per event. A batch over `maxBatchSize` (default 1000) or with a repeated event id is rejected with `{ ok: false, reason }` before anything is applied.
- `pull({ scopeKey, lastChangelogId?, limit? })` returns the next page of changes after an exclusive cursor (the last `changelogId`, a UUID v7 string), each re-authorized and resolved to its current record. A cursor that is not a UUID returns `{ ok: false, reason: "invalid-cursor" }`.
- Pass `syncServer` to `createSqlSyncAdapter` to use them. Existing options and methods are unchanged.
