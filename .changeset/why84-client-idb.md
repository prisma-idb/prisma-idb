---
"@prisma-idb/client-idb": minor
---

Fix grouping of BigInt fields and keep Date values separate from strings. Null and undefined still share a group.

Use the model name for related-store reads when storage metadata omits the store name.

Remove internal relation-mutation helpers from `/orm` and `autoMigrate` from `/client-auto`. The sync delete helpers now live in `/internal`; use the client factories and relation callbacks in application code.
