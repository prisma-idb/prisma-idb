---
"@prisma-idb/target-idb": minor
"@prisma-idb/client-idb": minor
---

`@@ignore` models and `@ignore` relations stay in the contract, hidden from the client:

- `target-idb` adds the `ignored` flag to model and relation storage, and `isIgnoredModel`/`isIgnoredRelation` in `@prisma-idb/target-idb/runtime`.
- `client-idb` has no accessor for an ignored model, leaves hidden relations out of the `include()` and nested-write types, and refuses them at runtime with an error that names the relation. Foreign-key checks and referential actions still run through them, including cascades into an ignored model's store.
