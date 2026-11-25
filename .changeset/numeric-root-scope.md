---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

Numeric tenant keys now match their string scope keys. PostgreSQL pull restores numeric keys from changelog text before reading records and sends numbers so IndexedDB can apply creates, updates and deletes.

Push rejects a PostgreSQL `float4` primary key if storing it would round the key. Pull and rejected-push records use the same exact value for a `float4` primary key and foreign keys referencing it.

Existing changelog entries work when they use the canonical string for the stored key. Pull skips legacy `float4` entries whose recorded key would round, such as `"0.1"`, and advances the cursor. Before upgrading, reconcile these keys against PostgreSQL and correct the stored scope keys for affected float4 roots. For clients already past them, reconcile affected IndexedDB rows and foreign keys from current server data or rebuild those clients from a corrected history.

When a finite key would round to another PostgreSQL `float4` value, push reconciliation removes the rejected local identity without reading or changing the rounded row. Keep PostgreSQL’s `extra_float_digits` at 1 or higher.
