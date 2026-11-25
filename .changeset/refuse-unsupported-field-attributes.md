---
"@prisma-idb/family-idb": patch
---

PSL attributes that IDB would drop are now refused instead of ignored:

- A field attribute IDB doesn't support, such as `@madeUp`, fails with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE`. A model attribute IDB doesn't support, such as `@@fulltext`, fails with `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`. `@map` remains available in shared SQL schemas. IDB also continues to ignore the legacy `@db.*` and `@@schema` spellings.
- A repeated `@default`, `@id`, `@unique`, `@relation`, `@onCreate`, `@onUpdate`, `@idb.exclude`, `@@map`, `@@id` or `@@idb.exclude` fails with `PSL_DUPLICATE_ATTRIBUTE`. Before, the first one won silently. A repeated `@onCreate` or `@onUpdate` is reported even when the first one fails to bind.
- `@relation` on a field whose type isn't a model fails with `IDB_INVALID_RELATION`.
- `@id`, `@unique`, `@default`, `@onCreate` or `@onUpdate` on a relation field fails with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE`. Before, it was dropped; `author User @relation(...) @unique` created no unique index. Put it on the foreign-key field.

These checks, and the refusal of `@updatedAt`, also cover fields and models marked `@idb.exclude` or `@@idb.exclude`, so a schema fails the same way when you emit the client contract and the full one.

This narrows the PSL that compiles: a schema that compiled before can now fail. Remove the attribute IDB reports.
