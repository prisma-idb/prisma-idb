---
"@prisma-idb/family-idb": patch
---

Reject incomplete PSL arguments for `@default`, `@onCreate` and `@onUpdate` after parser recovery, including on excluded fields and models. Use a decimal literal such as `100000` for a numeric default. Exponent notation such as `1e5` does not produce a default of `1`.
