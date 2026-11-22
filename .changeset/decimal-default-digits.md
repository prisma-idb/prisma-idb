---
"@prisma-idb/family-idb": patch
---

A `Decimal` literal default now keeps its digits and is stored as a decimal string, like every other Decimal value. Before, PSL read it as a JavaScript number, so `@default(1234567890123456789.123)` became `1234567890123456800`. TypeScript accepts a decimal string as a `Decimal` default; a number is stored as its string form.
