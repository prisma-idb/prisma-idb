---
"@prisma-idb/target-idb": patch
---

`coerce("int")` in a record transform now refuses a value that isn't a whole number in the `Int` range, from -2147483648 to 2147483647, and aborts the upgrade. Before, it turned `"1.5"` into `1.5` and `""` into `0`, and the upgrade stored values that any later `Int` write would reject.
