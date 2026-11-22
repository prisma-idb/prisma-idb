---
"@prisma-idb/family-idb": patch
---

PSL field attributes that IDB would drop are now refused instead of ignored:

- An attribute IDB doesn't support, such as `@madeUp`, fails with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE`. `@map` and `@db.*` are still accepted and ignored, so a schema shared with a SQL server compiles.
- A repeated `@default`, `@id`, `@unique` or `@relation` fails with `PSL_DUPLICATE_ATTRIBUTE`. Before, the first one won silently.
- `@relation` on a field whose type isn't a model fails with `IDB_INVALID_RELATION`.
