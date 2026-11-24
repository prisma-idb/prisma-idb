---
"@prisma-idb/client-idb": minor
---

Float aggregates handle infinite operands. A single sign propagates through sum and avg, while mixed signs return NaN. Min and max sort the infinities at the extremes.

PostgreSQL agrees on infinite operands when no finite input overflows its accumulator first.
