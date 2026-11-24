---
"@prisma-idb/sync-server": minor
"@prisma-idb/sync-server-sql": minor
---

A repeated push succeeds only when its scope, model, key, operation and canonical payload match the write recorded for that event id. A concurrent retry of a scoped delete succeeds after the original delete commits.

Before deploying, regenerate the server contract and migrate PostgreSQL to add the nullable `Changelog.payloadHash` text column. Existing changelog rows keep a null hash and still match on scope, model, key and operation.
