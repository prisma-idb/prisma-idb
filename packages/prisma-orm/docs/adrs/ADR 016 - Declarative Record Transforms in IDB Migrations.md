# ADR 016: Record transforms in migrations

- **Status:** Accepted.
- **Date:** 2026-08-13
- **Revised:** 2026-10-11; planner-generated transforms under [ADR 024](ADR%20024%20-%20Record%20Shape%20Is%20IDB%20Storage.md).
- **Area:** Migrations

## Summary

Add a migration operation, `transformRecords`, that rewrites every record in a store. It can rename fields, change a field's type, backfill a default, or remove a field. The operation is stored in `ops.json` as plain data, using a small fixed set of transforms, never as a function. A fixed executor applies it inside the upgrade transaction. `migration plan` now proposes literal-default backfills, field removals, and placeholders for changes that need an author decision. Authors can edit or add transforms in `migration.ts`.

## Context

### The original motivating bug

In `sync-extension-idb`, the `OutboxEvent.synced` field is a `Boolean`, and it's the key of the `bySynced` index. A boolean has never been a valid IndexedDB key: `IDBKeyRange.only(false)` throws `DataError` in every browser. The workaround in `outbox-store.ts` stops querying the index and filters in memory with `.filter((e) => !e.synced)`. That works, but the contract still has the wrong type, and `bySynced` is an index nobody can query.

The right type is `Int`, holding `0` or `1`, since numbers are valid keys. The original fix needed two things:

1. Change the field's type in the contract. That's easy.
2. Rewrite every existing record from `true`/`false` to `1`/`0`. The stack had no operation for that rewrite.

### The original gap

At the time of the original decision:

- **The schema differ ignored field types.** `diffIdbSchema` (`target-idb/src/core/schema-diff.ts`) only compares stores (`keyPath`, `autoIncrement`) and indexes (`keyPath`, `unique`, `multiEntry`). IndexedDB stores have no column types, so there is nothing to alter. Changing `synced` from `Boolean` to `Int` produces no operations, and `migration plan` reports that nothing changed.
- **The operation set is closed and purely structural.** `IdbDdlOp` (`target-idb/src/core/migration-factories.ts`) has exactly four kinds: `createObjectStore`, `dropObjectStore`, `createIndex` and `dropIndex`. `applyOneDdlOp` switches over those four only. A fifth kind written into `ops.json` by hand would silently do nothing.
- **The framework already has a slot for this.** Upstream `MigrationOperationClass` is `"additive" | "widening" | "destructive" | "data"`, where `"data"` means "data transformation operation (e.g., backfill, type conversion)". `family-idb`'s `migration-plan.ts` already allows `"data"`. No IndexedDB operation has used it yet.

[ADR 024](ADR%20024%20-%20Record%20Shape%20Is%20IDB%20Storage.md) closes the field-detection gap. `diffIdbSchema` still handles stores and indexes. The migration planner separately compares stored record shapes.

### How other targets do it

Postgres (`data-transform.ts`) and Mongo (`dataTransform()`) both let the author write what looks like a function in `migration.ts`. But they call that function once, when `node migration.ts` runs, and store only its result, as plain data:

- **Postgres** stores SQL text and parameters.
- **Mongo** stores an update or aggregation command document.

What runs against a real database is data, read by a fixed executor. Never a function, never `eval`.

IndexedDB has no equivalent language to lower a function into. SQL has `UPDATE … SET x = CASE WHEN …` and Mongo has `$set` and `$toInt`. IndexedDB's `cursor.update(value)` only takes a value that has already been computed. So to follow the same pattern, IndexedDB needs its own small vocabulary of transforms.

## Decision

### A new operation kind: `transformRecords`

```ts
export type IdbJsonLiteral = string | number | boolean | null;

export type IdbValueTransform =
  | { readonly kind: "placeholder"; readonly slot: string }
  | { readonly kind: "coerce"; readonly to: "int" | "string" | "boolean" | "isoDateString" }
  | { readonly kind: "defaultIfMissing"; readonly value: IdbJsonLiteral }
  | { readonly kind: "setLiteral"; readonly value: IdbJsonLiteral }
  | { readonly kind: "pipe"; readonly steps: readonly IdbValueTransform[] };

export type TransformRecordsOp = MigrationPlanOperation & {
  readonly kind: "transformRecords";
  readonly storeName: string;
  /** Per-field value transforms, keyed by field name. */
  readonly fields?: Readonly<Record<string, IdbValueTransform>>;
  /** `{ newName: oldName }`: moves a value to a new key. */
  readonly renameFields?: Readonly<Record<string, string>>;
  /** Fields to delete. */
  readonly removeFields?: readonly string[];
};
```

There are two kinds of change, kept apart on purpose:

- **Value changes** (`fields`) read one field's value and return its replacement. That makes them composable: `pipe` passes one value through several steps in order.
- **Shape changes** (`renameFields`, `removeFields`) change which keys a record has. Modelling a rename as a value transform would make it unclear which field is being read, so they are separate lists.

Renames read from the original record, remove all source fields, then write the destinations. Swaps and chains preserve the original values regardless of entry order.

For each record, the steps always run in this order: **rename, then transform values, then remove.** So you can rename a field and change its type in one pass, as long as the transform uses the new name.

The exported pure `transformRecord(op, value, mode)` returns a rewritten copy. `full` mode applies every transform. `patch` mode only transforms fields present after renaming. It skips `defaultIfMissing` and `setLiteral`, including inside `pipe`, so absent fields stay absent.

The executor rejects changes to key fields before opening the cursor. This includes both sides of a rename, value transforms, and removals. Compound key fields and the parent of a nested key path are protected because keys are immutable ([ADR 020](ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md)).

### The transforms

| Transform            | What it does                                                                          | Example                                 |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| `coerce`             | Converts a value to another primitive type.                                           | `coerce("int")`                         |
| `defaultIfMissing`   | Sets a value only if the field is `undefined`. An existing value, even `null`, stays. | `defaultIfMissing("member")`            |
| `setLiteral`         | Overwrites the field with a constant, whatever it held.                               | `setLiteral(0)`                         |
| `pipe`               | Applies several transforms in order.                                                  | `pipe(coerce("string"), coerce("int"))` |
| `renameFields` entry | Moves a value to a new key and deletes the old one.                                   | `renameFields: { isSynced: "synced" }`  |
| `removeFields` entry | Deletes a field.                                                                      | `removeFields: ["legacyPhoneNumber"]`   |

`placeholder("Model.field")` marks an unresolved value transform. It is not an executable conversion. Package emission, preflight, and runtime application reject it with `MIGRATION.UNFILLED_PLACEHOLDER`, including inside `pipe`. Validation reports all distinct unfilled slots in one framework `CliStructuredError`. Its `why` and `meta.slot` contain the comma-separated slot names.

### What `coerce` does with each input

| `to`              | From a `boolean`        | From a `number`                                                     | From a `string`                                                | From `null`/`undefined` |
| ----------------- | ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------- |
| `"int"`           | `true → 1`, `false → 0` | unchanged                                                           | `Number(value)`. **Throws** if the result is `NaN`.            | unchanged               |
| `"string"`        | `String(value)`         | `String(value)`                                                     | unchanged                                                      | unchanged               |
| `"boolean"`       | unchanged               | `value !== 0`                                                       | Only `"true"` and `"false"` convert. Anything else **throws**. | unchanged               |
| `"isoDateString"` | **Throws**              | Treated as epoch milliseconds, then `new Date(value).toISOString()` | Kept if `Date.parse` accepts it. Otherwise **throws**.         | unchanged               |

Invalid input throws instead of quietly becoming a plausible wrong value, such as `Number("abc")` becoming `0` or `Boolean("false")` becoming `true`. A throw inside `upgradeneeded` aborts the whole upgrade, so nothing is half-applied ([ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md)).

`null` and `undefined` pass through every `coerce` unchanged. To both fill in a missing value and change its type, combine them: `pipe(defaultIfMissing(...), coerce(...))`.

### Examples

The motivating fix, `synced` to `Int`:

```ts
// migrations/<timestamp>_synced_to_int/migration.ts
import { Migration, MigrationCLI, transformRecordsOp, coerce } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "sha256:7fde36649c356a3b6962006d44bb08e84372aa86bb23671252eab9b4cf45e798",
      to: "sha256:<computed-on-emit>",
    };
  }

  override get operations() {
    return [transformRecordsOp("_idb_sync_outbox", { fields: { synced: coerce("int") } })];
  }
}

MigrationCLI.run(import.meta.url, M);
```

Other cases:

```ts
// Rename a field.
transformRecordsOp("_idb_sync_outbox", { renameFields: { isSynced: "synced" } });

// Rename and change type in one pass. The transform uses the new name.
transformRecordsOp("_idb_sync_outbox", {
  renameFields: { isSynced: "synced" },
  fields: { isSynced: coerce("int") },
});

// Backfill a new required field on older records.
transformRecordsOp("users", { fields: { role: defaultIfMissing("member") } });

// Remove a deprecated or sensitive field from data already on the client.
transformRecordsOp("users", { removeFields: ["legacyPhoneNumber"] });

// Reset a corrupted cached value.
transformRecordsOp("posts", { fields: { commentCountCache: setLiteral(0) } });
```

### Authoring steps

The planner compares record shapes for existing stores. It emits `defaultIfMissing` for supported literal defaults on new required scalar fields and `removeFields` for deleted fields. Nullable additions and compatible widening changes need no rewrite. Required additions without a supported literal default and incompatible field changes produce `placeholder("Model.field")` slots. Defaults such as `now()` and `uuid()` are not literal backfills.

The planner writes `migration.ts`, `ops.json`, and `migration.json` with unresolved placeholders. Fill every slot before shipping. For the motivating `Boolean` to `Int` change:

1. Change `synced` to `Int` in the extension contract.
2. Run `pnpm --filter @prisma-idb/sync-extension-idb contract:emit`.
3. Run `npx prisma-idb migration plan --space idb-sync --name synced_to_int`. It scaffolds a `placeholder` for the incompatible field change. Emitting that scaffold unchanged fails with `MIGRATION.UNFILLED_PLACEHOLDER`.
4. Replace the slot with `coerce("int")` in `migration.ts`. Add its import from `@prisma-idb/target-idb/migration`.
5. Run `npx tsx migrations/<migration-folder>/migration.ts`. This regenerates `ops.json` and `migration.json` with a new package hash.
6. Add the new migration to the extension's `migrations` array in `src/exports/control.ts`.
7. Run `npx prisma-idb migration preflight` to check the chain.

For app migrations, run `npx prisma-idb migration contract-space` after regenerating the package. Commit the scaffold, emitted operations, metadata, snapshot, and bundled contract space together.

The planner never infers renames. To preserve a renamed field, replace its planned removal and addition with `renameFields: { newName: "oldName" }`. Keep unrelated transforms in the same operation. Do not remove or rename a primary-key field.

See [Author a field change](../../../../apps/docs/content/docs/prisma-8/field-changes.mdx) for the app workflow.

### How it runs: a cursor walk inside `upgradeneeded`, without `await`

The four existing operations are synchronous calls that return straight away. `transformRecords` is the first that has to walk a cursor over every record. It must follow [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md): each request is issued inside the previous request's `onsuccess`, with no `await`:

```ts
case "transformRecords": {
  const store = tx.objectStore(op.storeName);
  const cursorReq = store.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) {
      onDone();
      return;
    }
    cursor.update(transformRecord(op, cursor.value as Record<string, unknown>, "full"));
    cursor.continue(); // issued synchronously, inside this onsuccess
  };
  return; // onDone() is called later, when the cursor is exhausted
}
```

This changes `applyOneDdlOp(db, tx, op)` to `applyOneDdlOp(db, tx, op, onDone)`:

- **The four existing operations** call `onDone()` straight away. Their behaviour doesn't change.
- **Its two callers**, `openAndUpgrade` and `preflight.ts`'s `applyPackage`, currently loop over the operations. They become a recursive `runNext(i)` that moves on to the next operation only from `onDone()`. This is the same pattern as `runOpsSequentially` in the driver. Neither caller's own signature changes.

A failed request during the walk isn't caught separately. As with every other request, the error aborts the whole upgrade transaction, so nothing is half-applied.

## Alternatives considered

- **Guess a conversion or rename from a field diff.** Rejected: the planner can identify an incompatible shape, but only the author can choose the conversion or state a rename.
- **Require authors to discover every data change by hand.** Rejected by ADR 024: the planner renders known defaults, removals, and unresolved slots as TypeScript.
- **Only transform some records**, with a filter or a `when` clause. Every `transformRecords` walks the whole store. A conditional form is deferred until a real case needs it.
- **Store the function's source (`fn.toString()`) and `eval` it when applying.** It breaks when the app is minified or bundled, because the bundler renames or removes the identifiers the function uses. It also needs `unsafe-eval`, which clashes with any Content Security Policy the app sets. No other target does this. Rejected outright, even as an opt-in.

## Consequences

- **The IndexedDB target gains its first real data migration.** Renames, type changes, backfills and field removals all reuse the same transform vocabulary. An earlier idea, a single hard-coded `booleanToInt01` transform, would have needed a new operation for every case.
- **`ops.json` stays plain JSON.** No functions, no `eval`. Postgres and Mongo handle `"data"` operations the same way.
- **Unknown conversions need author input.** The planner names unresolved fields in placeholder slots. Emission rejects unfilled slots.
- **`applyOneDdlOp`'s signature changes.** Callers pass a completion callback. An optional error callback preserves exceptions from the cursor walk.
- **Cost grows with the store's size.** The walk visits every record before the upgrade can commit. For client-side data this is fine, but it would matter on an unexpectedly large store.
- **The vocabulary is deliberately small.** It doesn't compute one field from others, such as `fullName` from `firstName` and `lastName`, and it can't transform across stores. Adding a transform means adding an `IdbValueTransform` variant and a case in the executor.

## Open questions

- **Should data operations need explicit approval?** No. Authors review the operations in `migration.ts`, so preflight needs no approval flag.
- **Should `coerce` skip invalid values?** No. Invalid values abort the upgrade so every record and marker stays consistent.

## Related

- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md): the upgrade transaction this operation runs in.
- [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md): the no-`await` rule the cursor walk must follow.
- [ADR 011](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md): `--space` authoring works the same way for this operation.
- [ADR 023](ADR%20023%20-%20Migrations%20Rewrite%20Pending%20Outbox%20Payloads.md): how the same transform rewrites edits still queued in the sync outbox.
- `target-idb/src/core/migration-planner.ts`: record-shape diffing and generated transforms.
- `target-idb/src/core/schema-diff.ts`: structural store and index diffing.
- `target-idb/src/core/apply-ddl-op.ts`: `applyOneDdlOp` and `openAndUpgrade`, which change shape.
- `family-idb/src/core/preflight.ts`: `applyPackage`, which changes the same way.
- `sync-extension-idb/src/contract.ts` and `outbox-store.ts`: `OutboxEvent.synced`, the motivating case.
