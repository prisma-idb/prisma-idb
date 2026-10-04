---
"@prisma-idb/client-idb": patch
---

Fix grouping of BigInt fields and keep Date values separate from strings. Null and undefined still share a group.

Use the model name for related-store reads when storage metadata omits the store name.
