---
"@prisma-idb/family-idb": patch
---

Reject incomplete PSL default arguments after parser recovery. Use a decimal literal such as `100000` for a numeric default. Exponent notation such as `1e5` does not produce a default of `1`.
