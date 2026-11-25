---
"@prisma-idb/family-idb": minor
"@prisma-idb/target-idb": minor
"@prisma-idb/client-idb": patch
---

List fields accept nonempty literal defaults, as upstream Prisma does: `tags String[] @default(["new", "unverified"])` in PSL, or `defaults: { tags: ["new", "unverified"] }` in a TypeScript model.

- Each element must be a value a scalar default of the element type accepts: a String, Int, Float, Decimal or Boolean literal, or an enum member. A Float element must be finite, since the contract stores defaults as JSON. PSL reads an Int element from its digits as written, so `2147483647.00000001` is refused instead of rounded.
- Each created row gets its own copy, and a migration that adds the field backfills existing rows with the default.
- BigInt, DateTime, Bytes and Json lists still default only to `[]`.
- `IDB_LIST_DEFAULT_UNSUPPORTED` now only reports a list field listed in `fieldDefaults`.
- An invalid TypeScript default element, such as a `bigint` or a cyclic object, is reported as `IDB_INVALID_DEFAULT_VALUE` instead of throwing a `TypeError`.

Creates and updates now apply the default of a field named like an inherited object member, such as `toString` or `constructor`. Before, the client read the inherited member and left the field unset.
