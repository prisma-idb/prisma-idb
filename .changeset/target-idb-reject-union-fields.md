---
"@prisma-idb/target-idb": patch
---

Fail closed for unsupported union fields during record validation, JSON decoding, nullable-field normalization and migration planning. Union values can no longer pass through without decoding.
