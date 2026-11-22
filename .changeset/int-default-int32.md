---
"@prisma-idb/family-idb": patch
---

An `Int` literal default must now be a whole number from -2147483648 to 2147483647, in PSL and TypeScript. Before, `@default(1.5)` or `@default(2147483648)` emitted a contract, and every create that relied on the default then failed its `Int` check.
