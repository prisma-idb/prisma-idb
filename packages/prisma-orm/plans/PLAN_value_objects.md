# Value objects (PSL `type` blocks) end to end

Working notes for agents. Status: not started. Recorded 2026-11-21, after the Prisma `8.0.0-rc.24` upgrade.

## Goal

Let a prisma-idb schema declare value objects (Prisma composite types) and use them through the client and sync:

```prisma
type Nutrients {
  energyKcal Float
  proteinsG  Float
  sugarsG    Float?
}

model FoodEntry {
  id      String    @id
  per100g Nutrients
}

model Recipe {
  id          String       @id
  ingredients Ingredient[]
}
```

A value object has no identity, lives inside its parent row (one IndexedDB record, one Postgres `jsonb` column), and is read and replaced with the parent.

## Motivation: MyFit (`../MyFit`, branch `v4-turborepo`, `packages/shared/src/schema.prisma`)

- `FoodEntry` and `RecipeIngredient` each repeat the same 34 `*_100g` nutrient columns, a snapshot copied from `NutritionData`. That is a natural `Nutrients` value object. One option keeps the four core macros (energy, protein, fat, carbs) as columns for SQL aggregates and moves only the 30 optional micronutrients into the value object.
- `productName`, `brands`, `preferredUnit`, `servingQuantity` and `servingSize` are also repeated in both models. They could become a second value object.
- `RecipeIngredient` could become `Recipe.ingredients Ingredient[]`. That gives one row and one sync event per recipe edit, and the list keeps its order (the model has no `sortOrder` today). The trade-off is last-write-wins for the whole list on concurrent edits.
- These should stay models: `MacroTargets`, `MacroMetrics` and `ActivityPreferences` (versioned by `effectiveFrom`), and `ChatMessage` (unbounded, append-only). `ChatMessage.parts` stays `Json`, because it is a union and unions are rejected.
- `NutritionData` stays flat (server only; search indexes need real columns).
- Moving MyFit to value objects also needs data migrations on both sides: flat columns into a nested object (IDB record transform) and columns into `jsonb` (Postgres).

## What exists after rc.24

- Contract shape (upstream ADR 178 and ADR 309): value objects live at `storage.namespaces[ns].entries.valueObject[Name].fields`. A field refers to one with `type: { kind: "valueObject", plane: "storage", namespaceId, entityKind: "valueObject", entityName }`. A value object's enum field names a storage value set (`entries.valueSet[Name].values`), not a domain enum.
- Runtime support in `target-idb`: `validate-record.ts` (including storage value sets), `absent-as-null.ts`, `decode-json-record.ts`. In `family-idb`: `record-shape.ts` (embeds the shape in `IdbRecordShape`, so it feeds the storage hash) and `validate.ts` (rejects union fields in value objects).
- Tests build these contracts by hand. Examples: `target-idb/test/{validate-record,absent-as-null,decode-json-record}.test.ts`, `client-idb/test/{migration-field-default,scalar-writes}.test.ts`.

## What is missing

1. **PSL authoring** (`family-idb/src/core/psl-interpreter.ts`, `psl-binder.ts`): read `type` blocks from the symbol table. Map field types the same way model fields are mapped. Emit `storage.namespaces[ns].entries.valueObject` and storage value sets for enum fields. Reject relations, `@id`, `@unique`, `@@index` and `@default` inside `type` blocks, and recursion (`record-shape.ts` already throws on recursion). Check how upstream's SQL and Mongo PSL interpreters lower `type` blocks before writing our own.
2. **TypeScript authoring** (`family-idb/src/core/contract-builder.ts`): a way to declare a value object and use it as a field type, with parity tests in `family-idb/test/authoring-scenarios.ts`.
3. **Generated types**: check that `contract.d.ts` from our emission gives nested row and input types. Upstream's emitter handles `ValueObjectTypesFromStorage`; confirm `idbEmission` doesn't need its own hook.
4. **Client writes** (`client-idb`): create and update with nested objects (validated by `validateRecord` already). Decide on partial updates of a nested object: whole replacement only (simplest, matches upstream's v1 promise?), or `set` / `update` operators. Lists of value objects interact with the scalar-list operators (`push`, `set`). Check `scalar-list-reference.mdx` for how far that extends.
5. **Client reads and filters**: `where` on a nested field (`per100g: { proteinsG: { gt: 10 } }`) is not supported. Decide whether v1 allows it. The query planner can't index nested paths without compound-index work, so it would be a full scan.
6. **Migrations** (`target-idb/src/core/migration-planner.ts`): adding, removing or changing a value-object field changes the record shape and storage hash. Check that the planner emits the right transform (or nothing) for nested additions; `client-idb/test/migration-field-default.test.ts` covers a nullable nested addition. Required nested additions need a backfill story.
7. **Sync**: `sync-server-sql/src/core/wire-values.ts` revives scalar wire values by codec, so check nested values (dates inside a value object). The server validation codecs need `jsonb` columns. Confirm `sqlContractWithSync` passes `type` blocks through to the SQL family.
8. **Docs**: `apps/docs/content/docs/prisma-8/schema.mdx` and `contract-authoring.mdx`, with a "model or value object?" section using the MyFit examples.

## Open questions

- Whole-object replacement only in v1, or nested update operators?
- Filter on nested fields in v1?
- Does this need an ADR? Likely yes if we restrict what upstream allows, for example no nested filters.
- Depends on the rc.24 upgrade (value objects in storage). Branch from `main` after that lands.
