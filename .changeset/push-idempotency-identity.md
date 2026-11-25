---
"@prisma-idb/sync-server": minor
"@prisma-idb/sync-server-sql": minor
---

A repeated push succeeds only when its scope, model, key, operation and normalized payload match the write recorded for that event id. On create, explicit null and omission hash alike for nullable fields without a create default. For defaulted fields and required JSON fields, the hash preserves explicit null. Decimal strings such as `"1.0"` and `"1.00"` hash differently. A concurrent retry of a scoped delete succeeds after the original delete commits.

An outbox transform that changes the write between attempts, such as a model rename, field rename or literal backfill, makes the retry non-retryable even when the original push committed and its response was lost.

Before deploying, regenerate the PostgreSQL contract and apply the migration to add the nullable text column `Changelog.payloadHash`. The adapter refuses a contract without that field. Existing changelog rows keep a null hash and still match on scope, model, key and operation.
