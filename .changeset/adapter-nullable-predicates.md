---
"@prisma-idb/adapter-idb": patch
---

Preserve SQL unknown results for nullable comparisons through `and`, `or`, and `not`. Negative filters now exclude null and absent fields unless an explicit null check admits them. Membership lists follow SQL null semantics, while empty lists and explicit null checks keep their existing behavior.
