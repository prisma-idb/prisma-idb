---
"@prisma-idb/family-idb": patch
---

PSL model attributes that IDB would drop are now refused, as field attributes already are. An unsupported attribute such as `@@fulltext` fails with `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`; `@@schema` is still accepted and ignored. A repeated `@@map`, `@@id` or `@@idb.exclude` fails with `PSL_DUPLICATE_ATTRIBUTE`. Before, the first `@@map` won silently.
