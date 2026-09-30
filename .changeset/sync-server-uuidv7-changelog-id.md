---
"@prisma-idb/sync-server": minor
---

The synthetic `Changelog` model now uses a UUID v7 id (`String @id @default(uuid(7))`) instead of an integer autoincrement. Ids sort correctly as plain strings, so the pull cursor stays an opaque string and no numeric comparison is needed. This changes the `Changelog` table: regenerate the contract and migrate (or recreate) any existing `Changelog` table, and reset stored pull cursors, which were integers.
