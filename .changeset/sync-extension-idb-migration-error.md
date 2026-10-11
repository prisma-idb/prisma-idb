---
"@prisma-idb/sync-extension-idb": minor
---

Mark rejected outbox events with `migrationError` when a migration cannot convert their payload. Preserve the payload and server rejection reason for recovery. Plan the nullable `migrationError` and `versionMetaId` fields as an empty storage-hash migration; old rows read missing nullable fields as `null` without a backfill.
