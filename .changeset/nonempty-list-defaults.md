---
"@prisma-idb/family-idb": minor
"@prisma-idb/target-idb": minor
---

List fields accept nonempty literal defaults, as upstream Prisma does: `tags String[] @default(["new", "unverified"])` in PSL, or `defaults: { tags: ["new", "unverified"] }` in a TypeScript model. Each element must be a value a scalar default of the element type accepts (a String, Int, Float, Decimal or Boolean literal, or an enum member). Each created row gets its own copy, and a migration that adds the field backfills existing rows with the default. BigInt, DateTime, Bytes and Json lists still default only to `[]`. `IDB_LIST_DEFAULT_UNSUPPORTED` now only reports a list field listed in `fieldDefaults`.
