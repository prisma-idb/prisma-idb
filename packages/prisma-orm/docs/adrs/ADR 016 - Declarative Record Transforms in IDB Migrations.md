# ADR 016: Record transforms in migrations

- **Status:** Proposed. Not implemented, pending review.
- **Date:** 2026-08-13
- **Area:** Migrations

## Summary

Add a migration operation, `transformRecords`, that rewrites every record in a store. It can rename fields, change a field's type, backfill a default, or remove a field. The operation is stored in `ops.json` as plain data, using a small fixed set of transforms, never as a function. A fixed executor applies it inside the upgrade transaction. Authors add it to `migration.ts` by hand; `migration plan` never proposes it.

## Context

### The motivating bug

In `sync-extension-idb`, the `OutboxEvent.synced` field is a `Boolean`, and it's the key of the `bySynced` index. A boolean has never been a valid IndexedDB key: `IDBKeyRange.only(false)` throws `DataError` in every browser. The workaround in `outbox-store.ts` stops querying the index and filters in memory with `.filter((e) => !e.synced)`. That works, but the contract still has the wrong type, and `bySynced` is an index nobody can query.

The right type is `Int`, holding `0` or `1`, since numbers are valid keys. The fix needs two things:

1. Change the field's type in the contract. That's easy.
2. Rewrite every existing record from `true`/`false` to `1`/`0`. Nothing in this stack can do that today.

### Why nothing can do it today

- **The schema differ ignores field types.** `diffIdbSchema` (`target-idb/src/core/schema-diff.ts`) only compares stores (`keyPath`, `autoIncrement`) and indexes (`keyPath`, `unique`, `multiEntry`). IndexedDB stores have no column types, so there is nothing to alter. Changing `synced` from `Boolean` to `Int` produces no operations, and `migration plan` reports that nothing changed.
- **The operation set is closed and purely structural.** `IdbDdlOp` (`target-idb/src/core/migration-factories.ts`) has exactly four kinds: `createObjectStore`, `dropObjectStore`, `createIndex` and `dropIndex`. `applyOneDdlOp` switches over those four only. A fifth kind written into `ops.json` by hand would silently do nothing.
- **The framework already has a slot for this.** Upstream `MigrationOperationClass` is `"additive" | "widening" | "destructive" | "data"`, where `"data"` means "data transformation operation (e.g., backfill, type conversion)". `family-idb`'s `migration-plan.ts` already allows `"data"`. No IndexedDB operation has used it yet.

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

For each record, the steps always run in this order: **rename, then transform values, then remove.** So you can rename a field and change its type in one pass, as long as the transform uses the new name.

### The transforms

| Transform            | What it does                                                                          | Example                                 |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| `coerce`             | Converts a value to another primitive type.                                           | `coerce("int")`                         |
| `defaultIfMissing`   | Sets a value only if the field is `undefined`. An existing value, even `null`, stays. | `defaultIfMissing("member")`            |
| `setLiteral`         | Overwrites the field with a constant, whatever it held.                               | `setLiteral(0)`                         |
| `pipe`               | Applies several transforms in order.                                                  | `pipe(coerce("string"), coerce("int"))` |
| `renameFields` entry | Moves a value to a new key and deletes the old one.                                   | `renameFields: { isSynced: "synced" }`  |
| `removeFields` entry | Deletes a field.                                                                      | `removeFields: ["legacyPhoneNumber"]`   |

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

`migration plan` never proposes this operation, because the differ still ignores field types. For the motivating fix, the steps are:

1. In `src/contract.ts`, change `synced: "Boolean"` to `synced: "Int"`.
2. Run `pnpm --filter @prisma-idb/sync-extension-idb contract:emit`.
3. Run `prisma-idb migration plan --space idb-sync --name synced_to_int`. This writes a migration with an empty `ops.json`, since nothing structural changed. The step still matters: it moves the contract hash forward and creates `migration.ts` and `migration.json` with the right `from` and `to`.
4. Edit the new `migration.ts` and add the `transformRecordsOp(...)` call to `operations`.
5. Run `node migrations/<dir>/migration.ts`. This regenerates `ops.json` and `migration.json` from the edited file, with a new hash.
6. Add the new migration to the `migrations` array in `src/exports/control.ts`. This is already a manual step for every migration in this package, and `migration plan` prints a reminder.
7. Run `prisma-idb migration preflight` to check that the whole chain, including the new operation, applies cleanly.

Because step 5 always regenerates `ops.json` from `migration.ts`, the two files can't drift apart ([ADR 008](ADR%20008%20-%20Two%20Migration%20Paths.md)).

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
    cursor.update(transformOneRecord(cursor.value as Record<string, unknown>, op));
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

- **Teach the differ to detect field-type changes and propose a transform.** The differ would have to guess what the author meant. Is `Boolean` to `Int` a `coerce("int")`, or a rename that happens to change type? That's a human decision every time. Rejected: the operation is always written by hand.
- **Render the operation as TypeScript from the planner**, as SQL and Mongo do for generated migrations. That machinery exists because their migrations are sometimes generated from a diff. This operation never is, so there is nothing to render. Rejected.
- **Only transform some records**, with a filter or a `when` clause. Every `transformRecords` walks the whole store. A conditional form is deferred until a real case needs it.
- **Store the function's source (`fn.toString()`) and `eval` it when applying.** It breaks when the app is minified or bundled, because the bundler renames or removes the identifiers the function uses. It also needs `unsafe-eval`, which clashes with any Content Security Policy the app sets. No other target does this. Rejected outright, even as an opt-in.

## Consequences

- **The IndexedDB target gains its first real data migration.** Renames, type changes, backfills and field removals all reuse the same six transforms. An earlier idea, a single hard-coded `booleanToInt01` transform, would have needed a new operation for every case.
- **`ops.json` stays plain JSON.** No functions, no `eval`. Postgres and Mongo handle `"data"` operations the same way.
- **Authors must know this exists.** `migration plan` keeps producing empty diffs for pure type or value changes, and nothing prompts the author.
- **`applyOneDdlOp`'s signature changes.** This only affects its internal callers and tests, not any package's public API.
- **Cost grows with the store's size.** The walk visits every record before the upgrade can commit. For client-side data this is fine, but it would matter on an unexpectedly large store.
- **The vocabulary is deliberately small.** It doesn't compute one field from others, such as `fullName` from `firstName` and `lastName`, and it can't transform across stores. Adding a transform means adding an `IdbValueTransform` variant and a case in the executor.

## Open questions

- **Should data operations need explicit approval?** `migration plan`'s allowed operation classes don't apply here, because the author adds the operation after planning. Should `preflight` require something like `--allow-data-ops` before accepting a chain that contains one?
- **Should `coerce` be able to skip invalid values** instead of throwing, for example with `onInvalid: "throw" | "skip"`? This ADR chooses to always throw. It's easy to loosen later, and hard to tighten once someone relies on skipping.

## Related

- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md): the upgrade transaction this operation runs in.
- [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md): the no-`await` rule the cursor walk must follow.
- [ADR 011](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md): `--space` authoring works the same way for this operation.
- `target-idb/src/core/schema-diff.ts`: `diffIdbSchema`, which stays blind to field types.
- `target-idb/src/core/apply-ddl-op.ts`: `applyOneDdlOp` and `openAndUpgrade`, which change shape.
- `family-idb/src/core/preflight.ts`: `applyPackage`, which changes the same way.
- `sync-extension-idb/src/contract.ts` and `outbox-store.ts`: `OutboxEvent.synced`, the motivating case.
