---
"@prisma-idb/client-idb": patch
---

Compare and sort Decimal fields numerically without precision loss, including in refined relation queries and write filters. Avoid native string ranges and ordering for Decimal predicates, and apply numeric sorting before pagination. Invalid numeric Decimal operands are rejected before query execution.

Use numeric identity for scalar and compound Decimal primary and unique keys. Check collisions transactionally across create, update, bulk and nested writes. Preserve the stored spelling of an equivalent primary-key patch. Detect ambiguous legacy aliases instead of choosing a row. Decimal key checks scan stored rows; other key types retain native lookups.
