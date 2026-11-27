---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

A synced model whose primary key is mapped to another column, such as `id String @id @map("user_id")`, now syncs. `sqlGetKeyField` returned the column name, so push and pull looked the key up under `user_id` in records and ORM queries that use the field name `id`. It now returns the field name.

The sync server checks the key resolver for every synced model at startup. Unsupported compound keys fail when the server is created, and the error says to exclude the model from the client contract, or, for the sync root model, to give it a single-field primary key.
