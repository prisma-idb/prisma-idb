---
"@prisma-idb/family-idb": minor
---

PSL `@ignore` and `@@ignore` now work as in Prisma: the field or model is left out of the contract in every projection, `projection: "full"` included. Before this release, a schema using them failed with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE` or `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`.

- A relation to an `@@ignore` model is omitted automatically.
- Ignoring a backrelation preserves its owning relation. Ignoring the owner removes the matching backrelation and leaves the foreign-key scalars as plain fields. Named relations between the same models are handled individually.
- A primary key, an index or a relation that isn't ignored can't use an `@ignore` field, and neither can `@id` or `@unique` on the field itself: the schema fails with `IDB_IGNORED_FIELD_REFERENCED`.

They don't mark data as server-only; `@idb.exclude` and `@@idb.exclude` still do. `stripIdbExcludeAttributes` leaves `@ignore` and `@@ignore` in the schema the sync server hands to the SQL family, which keeps ignored scalars and models in the server contract and refuses `@ignore` on a list backrelation. In a synced model, an `@ignore` field must be optional or have a default.
