---
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/sync-server-sql": minor
---

Pull every waiting page in one sync cycle. The pull endpoint now responds with `{ logs, hasMore }` instead of a bare array, and `pull` returns `hasMore` alongside `logs`. While `hasMore` is true, the sync worker pulls the next page right away, pushing any new local edits between pages, instead of waiting `intervalMs` per page. A custom `pullHandler` must now return `{ logs, hasMore }`. Export `PullPage` and `pullResponseSchema`. Update the client and server together: an older client cannot parse the new response.
