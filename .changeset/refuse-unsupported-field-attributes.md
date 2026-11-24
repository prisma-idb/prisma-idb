---
"@prisma-idb/family-idb": patch
---

PSL attributes that IDB would drop are now refused instead of ignored:

- A field attribute IDB doesn't support, such as `@madeUp`, fails with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE`. A model attribute IDB doesn't support, such as `@@fulltext`, fails with `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`. `@map`, `@db.*` and `@@schema` are still accepted and ignored, so a schema shared with a SQL server compiles.
- A repeated `@default`, `@id`, `@unique`, `@relation`, `@idb.exclude`, `@@map`, `@@id` or `@@idb.exclude` fails with `PSL_DUPLICATE_ATTRIBUTE`. Before, the first one won silently.
- `@relation` on a field whose type isn't a model fails with `IDB_INVALID_RELATION`.

These checks also cover fields and models marked `@idb.exclude` or `@@idb.exclude`, so a schema fails the same way when you emit the client contract and the full one.

This narrows the PSL that compiles: a schema that compiled before can now fail. Remove the attribute IDB reports.
