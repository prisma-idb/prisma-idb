---
"@prisma-idb/family-idb": minor
---

Add create-time defaults to `defineContract`, and index foreign keys by default.

- A model's new `defaults` map takes `autoincrement()`, `now()`, `uuidv4()`, `uuidv7()`, `cuid2()` and `updatedAt()` from `@prisma-idb/family-idb/contract-ts`, or a literal value. They match PSL `@default(...)` and `@updatedAt`. A contract that uses them now carries an `executionHash`, and `create()` fills them as it does for PSL contracts. `fieldDefaults` still feeds only the `setDefault` referential action.
- Every to-one relation (`N:1` and `1:1`) now indexes its foreign-key fields, for TypeScript contracts as well as PSL. A TypeScript contract with relations therefore gets a new `storageHash`, and its next migration adds one index per foreign key. A declared index named like the foreign-key field replaces the implicit one. To keep a relation unindexed, set `index: false` on it. PSL contracts keep their `storageHash` and have no opt-out. The one exception is a foreign-key field named like an inherited object key, such as `constructor`, which PSL previously left unindexed and now indexes.
- A foreign-key field whose type IndexedDB cannot index, such as `Boolean`, is now rejected in TypeScript contracts, as it already was in PSL. Set `index: false` on the relation to keep it.
