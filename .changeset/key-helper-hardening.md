---
"@prisma-idb/target-idb": patch
---

- `isValidIdbKey` now rejects invalid `Date`s and arrays with holes or repeated (including cyclic) references, matching what IndexedDB accepts. A cyclic array used to overflow the stack.
- `fieldValueToken` now gives strings their own prefix, so no string can share a token with a `Date`, binary or array value.
