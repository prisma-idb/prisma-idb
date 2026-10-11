---
"@prisma-idb/sync-extension-idb": minor
---

Mark rejected outbox events with `migrationError` when a migration cannot convert their payload. Preserve the payload and server rejection reason for recovery. Add the missing `versionMetaId` field to the emitted contract. Backfill both missing fields to `null` on existing outbox rows. Preserve existing values and keep the storage hash unchanged.
