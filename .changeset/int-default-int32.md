---
"@prisma-idb/family-idb": patch
---

`Int` and `Decimal` literal defaults now keep the values every write accepts:

- An `Int` literal default must be a whole number from -2147483648 to 2147483647, in PSL and TypeScript. PSL reads the digits as written, so `@default(1.0)` and `@default(2147483647.00000001)` are refused instead of rounding to a valid `Int`. Before, `@default(1.5)` or `@default(2147483648)` emitted a contract, and every create that relied on the default then failed its `Int` check.
- A `Decimal` literal default keeps its digits and is stored as a decimal string, like every other Decimal value. Before, PSL read it as a JavaScript number, so `@default(1234567890123456789.123)` became `1234567890123456800`. TypeScript accepts a decimal string as a `Decimal` default; a number is stored as its string form.
