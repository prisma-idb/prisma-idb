---
"@prisma-idb/family-idb": minor
---

Validate PSL and TypeScript contract definitions with the same rules and diagnostic wording. TypeScript `defineContract` now throws the public `IdbContractError`, whose `diagnostics` array and message include every shared validation error with its `IDB_*` code. PSL diagnostics retain source spans.

PSL now rejects optional enum lists (`Role[]?`), scalar lists (`String[]`), enum names that conflict with scalar types (`enum String`), unknown fields in `@@index` and `@@id`, and `@idb.exclude` on back-relation lists in client projections. A scalar field's `@unique` keeps its uniqueness when declared after `@relation`. Optional `temporal.updatedAt()?` fields are rejected. Shared errors use one wording on both authoring surfaces.
