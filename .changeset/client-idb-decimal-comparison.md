---
"@prisma-idb/client-idb": patch
---

Compare and sort Decimal fields numerically without precision loss, including in refined relation queries and write filters. Avoid native string ranges and ordering for Decimal predicates, and apply numeric sorting before pagination. Invalid numeric Decimal operands are rejected before query execution.
