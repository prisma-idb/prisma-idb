---
"@prisma-idb/target-idb": patch
"@prisma-idb/family-idb": patch
---

Migration planning and `prisma-idb migration preflight` now handle store and index names that match `Object.prototype` members, such as `toString` or `constructor`. Before, both treated these names as always present:

- Planning skipped creating or dropping such a store or index, or failed with a `TypeError`.
- Preflight missed an extra store or index with such a name, and failed with a `TypeError` when one was missing.

`__proto__` is still a reserved name, and authoring refuses it.
