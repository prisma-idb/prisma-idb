---
"@prisma-idb/family-idb": minor
---

PSL `@ignore` and `@@ignore` now work as in Prisma. Before this release, a schema using them failed with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE` or `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`.

- An `@ignore` scalar field is left out of the contract in every projection, `projection: "full"` included.
- An `@@ignore` model keeps its store, records, foreign keys and referential actions, but the client has no accessor for it. Its relations, and relations to it, are hidden from the client. As in Prisma, it doesn't need `@id` or `@@id`: without a key, its store has no key path and IndexedDB generates each row's key. A model that isn't `@@ignore` still fails with `IDB_MISSING_ID` without `@id` or `@@id`, even when it has `@unique` or `@@unique`. Prisma refuses such a model only when it has no unique field or index at all, but IndexedDB needs a key path for the store of every model the client reads and writes.
- An `@ignore` relation field is hidden from the client but still enforces its foreign key and `onDelete`/`onUpdate` actions. Ignoring an owning relation also hides its backrelation; ignoring only a backrelation hides only that field. Named relations between the same models are handled individually.
- The contract marks these with `ignored: true` in the model's `storage` and in `storage.relations`, and `contract.d.ts` carries the flags. Adding or removing `@ignore`/`@@ignore` changes no store and plans no migration.
- A primary key, an index or a relation can't use an `@ignore` scalar field, and neither can `@id` or `@unique` on the field itself: the schema fails with `IDB_IGNORED_FIELD_REFERENCED`. This includes an `@ignore` relation, which still needs its foreign-key fields.
- TypeScript models and relations take `ignored: true`, and an ignored TypeScript model may omit `key`. A TypeScript relation flag hides only that relation, so set it on both sides to hide both.

They don't mark data as server-only; `@idb.exclude` and `@@idb.exclude` still do. `stripIdbExcludeAttributes` leaves `@ignore` and `@@ignore` in the schema the sync server hands to the SQL family, which keeps ignored scalars, models and owning relations in the server contract and refuses `@ignore` on a list backrelation. In a synced model, an `@ignore` scalar field must be optional or have a default.
