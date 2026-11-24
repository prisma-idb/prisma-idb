---
"@prisma-idb/family-idb": minor
---

PSL `@ignore` and `@@ignore` now work as in Prisma: the field or model is left out of the contract in every projection, `projection: "full"` included. Before this release, a schema using them failed with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE` or `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`.

- A relation field that points to an `@@ignore` model must be marked `@ignore` too, or the schema fails with `IDB_INVALID_RELATION`.
- When either side of a relation is `@ignore`, the relation leaves the contract on both sides, and its foreign-key fields stay as plain fields.
- A primary key, an index or a relation that isn't ignored can't use an `@ignore` field: the schema fails with `IDB_IGNORED_FIELD_REFERENCED`.

They don't mark data as server-only; `@idb.exclude` and `@@idb.exclude` still do. `stripIdbExcludeAttributes` leaves `@ignore` and `@@ignore` in the schema the sync server hands to the SQL family.
