---
"@prisma-idb/family-idb": patch
---

Breaking: a model, store, field, relation, index, enum or enum member named `__proto__` or `_generated` fails with `IDB_RESERVED_NAME` in PSL and TypeScript, and so does a store named `_prisma_next_marker`. JavaScript reads `__proto__` as an object's prototype rather than as a key, so it can't be kept as a name. Contract emission drops every key named `_generated`, so before, a field or relation with that name silently vanished from the emitted contract. The client always creates the `_prisma_next_marker` store for the contract marker, so a model stored under that name collided with it. Rename the model, field or store.

An index named `__proto__` previously reported `IDB_INVALID_INDEX`. It now reports `IDB_RESERVED_NAME` like the other reserved names.
