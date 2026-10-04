---
"@prisma-idb/adapter-idb": patch
---

Tidy the filter evaluator and correct docs. No behavior change.

- Type the filter evaluator's operator as `IdbFilterOp`.
- Describe `lower()` as the passthrough it is. The docs claimed it encodes field values.
