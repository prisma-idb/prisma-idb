---
"@prisma-idb/client-idb": patch
---

Validate native scalar values and record shapes before ORM local writes. Creates require every declared field after defaults, including explicit `null` for empty nullable fields; only omitted native autoIncrement keys are exempt. Updates validate supplied fields and reject remaining `undefined` values and incomplete value-object replacements. Scalar and shape failures throw the exported `IdbRecordValidationError` and roll back active transactions.
