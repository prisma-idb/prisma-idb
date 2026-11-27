---
"@prisma-idb/target-idb": patch
---

`coerce("int")` in a record transform now accepts only values that convert to a whole number in the `Int` range, from -2147483648 to 2147483647. Any other value aborts the upgrade. `null` and `undefined` still pass through unchanged. A string must be decimal text with an all-zero fraction, if any.

Before, the transform stored values it should have refused:

- `"1.5"` became `1.5`, which isn't a valid `Int`.
- `""` became `0`, and `"0x10"` became `16`. These are valid `Int`s, but almost certainly not the intended values.
