---
"@prisma-idb/sync-extension-idb": patch
---

A pulled delete that cascades to many rows of a model with a `Decimal` key now reads the sync version metadata once, instead of once per row, when it checks those rows for unsent edits.
