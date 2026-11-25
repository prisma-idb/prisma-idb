---
"@prisma-idb/target-idb": patch
---

`coerce("int")` in a record transform now refuses a value that isn't a whole number in the `Int` range, from -2147483648 to 2147483647, and aborts the upgrade. A string must be decimal text with an all-zero fraction, if any, so `"0x10"`, `"1e3"` and `"1.00000000000000001"` are refused too. Before, it turned `"1.5"` into `1.5`, `""` into `0` and `"0x10"` into `16`, and the upgrade stored values that any later `Int` write would reject.
