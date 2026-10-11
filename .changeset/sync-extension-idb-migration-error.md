---
"@prisma-idb/sync-extension-idb": minor
---

Mark rejected outbox events with `migrationError` when a migration cannot convert their payload. Preserve the payload and server rejection reason for recovery. Add the missing `versionMetaId` field to the emitted contract; neither field requires a storage migration.
