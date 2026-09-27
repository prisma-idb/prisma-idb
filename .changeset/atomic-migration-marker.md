---
"@prisma-idb/target-idb": minor
"@prisma-idb/client-idb": patch
---

Migrations now write their contract markers inside the same `upgradeneeded` transaction as their schema changes, so the two commit together or not at all. Previously the markers were written in a separate transaction after the upgrade. If the app was closed in between, the database kept the new schema with the old marker, and the next open replayed the migration.

A failed upgrade now rejects with the error that caused it, instead of IndexedDB's generic `AbortError`. If the marker store is missing when markers need writing, the upgrade fails and rolls back. It used to log a warning and commit the schema without a marker. `writeMarkers` likewise rejects when the marker store is missing, instead of warning and resolving.
