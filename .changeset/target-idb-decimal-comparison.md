---
"@prisma-idb/target-idb": patch
---

Add exact comparison of finite Decimal strings without number conversion. Reject malformed and non-finite Decimal text during record validation while preserving valid input strings.
