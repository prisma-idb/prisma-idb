# ADR 016 — Declarative Record Transforms in IDB Migrations

## Status

Proposed — draft, pending review.

## Context

`sync-extension-idb`'s `OutboxEvent.synced` field is typed `Boolean` (`src/contract.ts`) and is the `keyPath` of the `bySynced` index. `Boolean` has never been a valid IndexedDB key type — `IDBKeyRange.only(false)` throws `DataError` in every real browser, not just a `fake-indexeddb` quirk. This was fixed pragmatically by dropping the index query in favor of an in-memory `.filter((e) => !e.synced)` scan (`outbox-store.ts`), which works because `false`/`0` are both falsy — but it leaves the contract lying about the field's type for every install that ever synced before the fix, and leaves `bySynced` permanently dead: a real index that can never be queried, because you cannot construct a valid `IDBKeyRange` over a boolean.

The correct type is `Int` (`0`/`1`) — `Number` has always been a valid IDB key. Making that change for real requires two things: (1) the contract's field type, and (2) rewriting the value stored in every existing record from `true`/`false` to `1`/`0`. The first is trivial. The second turned out not to be supported by anything in this framework, for reasons worth recording:

- **`diffIdbSchema` (`target-idb/src/core/schema-diff.ts`) never looks at field types.** It only compares object-store `keyPath`/`autoIncrement` and index `keyPath`/`unique`/`multiEntry`, because IndexedDB stores are schemaless — there's no DDL concept of a column type to alter. Flipping `synced: "Boolean"` → `"Int"` in `src/contract.ts` with `bySynced`'s `keyPath` unchanged produces **zero** ops. `migration plan` reports "contract is unchanged since the last migration — nothing to do."
- **`IdbDdlOp` (`target-idb/src/core/migration-factories.ts`) is a closed union of exactly four purely structural kinds** — `createObjectStore`, `dropObjectStore`, `createIndex`, `dropIndex`. `applyOneDdlOp` (`target-idb/src/core/apply-ddl-op.ts:29`) is an exhaustive `switch` over exactly those four, with no data-mutation case. A hand-invented fifth `kind` written directly into `ops.json` would silently no-op at apply time — nothing case-matches, nothing throws.
- **The framework already has a slot for this.** Upstream `MigrationOperationClass` (`vendor/prisma-next/.../control-migration-types.ts:76`) is `'additive' | 'widening' | 'destructive' | 'data'`, with `'data'` documented as "Data transformation operation (e.g., backfill, type conversion)". `migration-plan.ts:176` already passes `"data"` into `allowedOperationClasses`. Nothing in `target-idb` has ever produced an op of that class — the door was left open, nobody walked through it.
- **Postgres and Mongo already solve this class of problem, and neither ships a function.** `postgres/src/core/migrations/operations/data-transform.ts` and the Mongo `dataTransform()` in `mongo-target/.../migration-factories.ts` both accept what looks like an arbitrary closure at the `migration.ts` call site — but both _invoke the closure once, at author-time_, inside `node migration.ts` (a real Node process, full JS environment), and lower its return value to inert, JSON-serializable data before anything touches `ops.json`. Postgres lowers to `{sql, params}` text. Mongo lowers to a serializable update/aggregation command document (BSON, itself just JSON). In both cases the thing replayed against a real user's database is pure data, interpreted by a fixed, generic executor — never a function, never `eval`.
- **IDB has no declarative mutation language to lower a closure into.** SQL has `UPDATE ... SET x = CASE WHEN ...`. Mongo has `$set`/`$toInt`/aggregation pipelines. Raw `cursor.update(value)` just takes a literal JS value the caller already computed — there is no IDB-native expression syntax to compile a closure down to. To follow the same "author writes ergonomic code, `ops.json` holds inert data" shape every other target in this framework already uses, IDB needs its own small declarative value-expression vocabulary — there's no existing one to borrow.
- **Storing `fn.toString()` and `new Function(...)`-evaling it at apply time was considered and rejected.** It doesn't survive minification/bundling (`tsdown`/esbuild rename captured identifiers and can inline/dead-code-eliminate), and it requires `unsafe-eval`, which conflicts with any CSP a consuming app sets. No other target in this framework does this, for the same reasons.

## Decision

### A new, closed `IdbDdlOp` kind: `transformRecords`

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
  /** Per-field value transforms, keyed by field name. Applied to `record[field]`. */
  readonly fields?: Readonly<Record<string, IdbValueTransform>>;
  /** `{ newName: oldName }` — moves a value between keys. Applied before `fields`. */
  readonly renameFields?: Readonly<Record<string, string>>;
  /** Field names to delete outright. Applied after `fields`. */
  readonly removeFields?: readonly string[];
};
```

`fields` is deliberately a pure value→value map — every member of `IdbValueTransform` reads `record[field]` and produces its replacement, which is what makes `pipe` composable (`pipe`'s steps thread a single value through in order). `renameFields`/`removeFields` operate on the record's key-space rather than a single field's value, so they're kept as separate top-level maps instead of being forced into the same value-transform shape — trying to model "rename" as a value transform (`pipe(rename("synced"), coerce("int"))`, operating on one nominal field) produces an awkward "which field am I actually reading" ambiguity; keeping shape-changes and value-changes as two distinct phases avoids that.

Per record, application order is fixed: **`renameFields` → `fields` → `removeFields`** — so a field can be renamed and then have its new name's value coerced in the same pass (see the combined example below), and a field can be transformed and then still be removed later in the same pass if it turns out to be fully deprecated.

### The op vocabulary

| Kind (in `fields`)   | Purpose                                                                                                          | Shape                                                                       | Example                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| `coerce`             | Convert a field's stored value to a different primitive representation                                           | `{ kind: "coerce", to: "int" \| "string" \| "boolean" \| "isoDateString" }` | `coerce("int")`                         |
| `defaultIfMissing`   | Backfill a field that's `undefined` on the stored record; leaves any existing value (including `null`) untouched | `{ kind: "defaultIfMissing", value: IdbJsonLiteral }`                       | `defaultIfMissing("member")`            |
| `setLiteral`         | Unconditionally overwrite a field with a constant, ignoring whatever was there                                   | `{ kind: "setLiteral", value: IdbJsonLiteral }`                             | `setLiteral(0)`                         |
| `pipe`               | Compose several value transforms into one, left to right                                                         | `{ kind: "pipe", steps: readonly IdbValueTransform[] }`                     | `pipe(coerce("string"), coerce("int"))` |
| `renameFields` entry | Move a value from one key to another; the old key is deleted                                                     | _(op-level map, not a value transform)_ `{ [newName]: oldFieldName }`       | `renameFields: { isSynced: "synced" }`  |
| `removeFields` entry | Delete a field outright, regardless of its value                                                                 | _(op-level list, not a value transform)_ string field name                  | `removeFields: ["legacyPhoneNumber"]`   |

### `coerce` semantics, by source value

| `to`              | `boolean` input     | `number` input                                        | `string` input                                                                      | `null`/`undefined` |
| ----------------- | ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| `"int"`           | `true→1`, `false→0` | passthrough as-is                                     | `Number(value)`; **throws** if the result is `NaN`                                  | passthrough as-is  |
| `"string"`        | `String(value)`     | `String(value)`                                       | passthrough as-is                                                                   | passthrough as-is  |
| `"boolean"`       | passthrough as-is   | `value !== 0`                                         | exact literal match only — `"true"→true`, `"false"→false`, anything else **throws** | passthrough as-is  |
| `"isoDateString"` | **throws**          | treated as epoch ms → `new Date(value).toISOString()` | validated via `Date.parse`; passthrough if valid, **throws** if not                 | passthrough as-is  |

Unparseable/unrepresentable inputs throw rather than silently coercing to a wrong-but-plausible value (e.g. `Number("abc")` silently becoming `0`, or a loose `Boolean("false")` silently becoming `true`). This matches the existing philosophy already stated twice elsewhere in this codebase: `schema-diff.ts`'s store-mutation guard ("silent no-op is worse than an explicit error") and `apply-ddl-op.ts`'s idempotency-guard doc comment. A migration that throws mid-`upgradeneeded` aborts the whole version-change transaction — nothing partially applies (see ADR 002).

`null`/`undefined` always pass through every `coerce` unchanged — compose with `defaultIfMissing` first (via `pipe`) if a field needs both a fallback and a type change.

### Worked examples

**The motivating bug** — `synced` needs to become a real `Int`:

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
    return [
      transformRecordsOp("_idb_sync_outbox", {
        fields: { synced: coerce("int") },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
```

**Field rename**, e.g. `synced` → `isSynced`:

```ts
transformRecordsOp("_idb_sync_outbox", {
  renameFields: { isSynced: "synced" },
});
```

**Rename and retype in the same pass** — the coerce targets the field under its _new_ name, since `renameFields` runs first:

```ts
transformRecordsOp("_idb_sync_outbox", {
  renameFields: { isSynced: "synced" },
  fields: { isSynced: coerce("int") },
});
```

**Backfilling a newly-required field** on records written before the field existed:

```ts
transformRecordsOp("users", {
  fields: { role: defaultIfMissing("member") },
});
```

**Dropping a deprecated/sensitive field** from data already synced to the client (a local GDPR-style purge, or just cleanup after a schema change removed the field server-side):

```ts
transformRecordsOp("users", {
  removeFields: ["legacyPhoneNumber"],
});
```

**Force-resetting a corrupted computed/cache field**, ignoring its current value entirely:

```ts
transformRecordsOp("posts", {
  fields: { commentCountCache: setLiteral(0) },
});
```

### How this actually gets authored — `migration plan` never proposes it

`diffIdbSchema` still never looks at field types (that's unchanged and intentionally out of scope — see "What we deliberately did not build"), so `prisma-idb migration plan` never emits a `transformRecords` op on its own. The full authoring flow for the motivating example:

1. `src/contract.ts` — change `synced: "Boolean"` to `synced: "Int"`.
2. `pnpm --filter @prisma-idb/sync-extension-idb contract:emit`.
3. `prisma-idb migration plan --space idb-sync --name synced_to_int` — writes a new migration package with an **empty** `ops.json` (no structural diff), because IDB is schemaless at the field level. This step still matters: it's what advances `end-contract.json`/`storageHash` and scaffolds `migration.ts`/`migration.json` with the right `from`/`to` pair.
4. Hand-edit that migration's `migration.ts`, adding the `transformRecordsOp(...)` call to `operations` (as above).
5. `node migrations/<dir>/migration.ts` — the file's own self-emit CLI (`MigrationCLI.run`, `migration-cli.ts`) — re-emits `ops.json`/`migration.json` from the edited `operations` getter, now containing the real op and a recomputed content hash.
6. Add the new migration's `{dirName, metadata, ops}` entry to the `migrations: [...]` array in `src/exports/control.ts` by hand (this is already a manual step for every incremental migration in this package today — `migration plan` prints a reminder to that effect, per `migration-plan.ts:373`).
7. `prisma-idb migration preflight` — replays the whole chain against `fake-indexeddb`, including the new cursor-based op, to confirm it applies cleanly end to end.

Because `ops.json` is unconditionally regenerated from `operations` in step 5, there is never a risk of the two files drifting (the exact class of bug `family-idb/test/generate-baseline.test.ts`'s `"migration.ts matches ops.json exactly"` test already guards against for the structural ops — the same guarantee extends here for free, since it's the same emit path).

### Execution model — cursor iteration inside `upgradeneeded`, no `await`

ADR 005 established that nothing may `await` between IDB request issuance inside a live transaction's event handlers — a transaction auto-commits once an event handler returns without issuing another request, and `await` yields to the microtask queue in the gap. `applyOneDdlOp`'s four existing cases are synchronous IDB calls (`db.createObjectStore`, `store.createIndex`, etc.) and return immediately; `transformRecords` is the first case that's inherently asynchronous (a cursor walk over however many records the store holds), so it has to follow the same callback-chaining pattern ADR 005 already documents for `driver-idb/src/core/execute/ops.ts`'s `runOpsSequentially()` — never a `Promise`/`await` inside the cursor's `onsuccess`.

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
    cursor.continue(); // issued synchronously, inside this same onsuccess — no await
  };
  return; // completion signaled later, via onDone() from inside the terminal onsuccess
}
```

This forces a signature change: `applyOneDdlOp(db, tx, op)` (synchronous, `void`) becomes `applyOneDdlOp(db, tx, op, onDone: () => void)` — the four existing cases call `onDone()` synchronously at the end of their case (no behavior change), the new case calls it from the cursor's terminal `onsuccess`. Both current call sites' own `for (const op of ops) { applyOneDdlOp(db, tx, op); }` loops — `openAndUpgrade` (`apply-ddl-op.ts:214-219`) and `preflight.ts`'s `applyPackage` (`preflight.ts:128-131`) — become a recursive `runNext(i)` that only advances to `i + 1` from inside `onDone()`, mirroring the exact pattern already established for `runOpsSequentially()` rather than inventing a new one. Neither function's _own_ external signature changes (`openAndUpgrade` still returns `Promise<number>`; `applyPackage` still returns `Promise<void>`) — this is entirely internal to how they walk their op list.

Errors during the cursor walk (`cursorReq.onerror`) are not separately caught — like every other IDB request in this codebase, an unhandled request error propagates to the transaction's `onerror`/`onabort`, aborting the whole `upgradeneeded` transaction. Nothing partially applies, consistent with every existing DDL op.

## Consequences

- **This is the first genuine data-migration capability this target has ever had.** Every future "field renamed", "field retyped", "backfill a computed default", or "drop a deprecated field from already-synced data" need reuses the same six-entry vocabulary — not a bespoke enum member per transform, which is what an earlier, narrower version of this idea (a single hardcoded `booleanToInt01` transform name) would have required for every future case.
- **`ops.json` stays 100% inert JSON.** No function, no `fn.toString()`, no `eval`. This keeps IDB consistent with how Postgres/Mongo already handle `operationClass: "data"` in this same framework — author-time convenience, apply-time pure data.
- **`transformRecords` is always hand-authored, never auto-generated.** `diffIdbSchema` staying field-type-blind is unchanged (and correct — see below); `migration plan` will keep emitting empty diffs for pure type/value changes. An author has to know to reach for this op; nothing prompts them to.
- **`applyOneDdlOp`'s signature change is a breaking, internal-only change**, contained to its three known callers (`openAndUpgrade`, `preflight.ts`'s `applyPackage`, and any direct test usage) — none of which are part of any package's public API surface.
- **A whole-store cursor walk is O(n) in that store's row count**, run synchronously (in wall-clock terms, still inside one `upgradeneeded` transaction, just spread across many `onsuccess` turns) before the version-change transaction can commit. For the stores this framework actually deals with (client-local IDB data, not a multi-million-row server table), this is a non-issue; worth flagging as a real cost if this is ever pointed at an unexpectedly large store.
- **The vocabulary is intentionally small and closed.** It covers the concrete cases already enumerated (retype, rename, backfill, remove, force-reset) but not, e.g., computing one field from another (`fullName` from `firstName + lastName`) or cross-store transforms. Extending it further is a matter of adding another `IdbValueTransform` variant plus an `applyValueTransform` case — the same shape of change as this ADR itself, not a redesign.

## What we deliberately did not build

- **No expansion of `diffIdbSchema` to detect field-type changes.** IDB genuinely doesn't enforce field types at the storage layer — teaching the differ to notice a contract-level type change and _auto-propose_ a `transformRecords` op would require guessing the author's intent (is `Boolean→Int` a `coerce("int")`, or actually an unrelated field rename that happens to change type too?). That guess belongs to a human, every time. This op stays exclusively hand-authored.
- **No `renderTypeScript()`/planner-IR integration for this op**, unlike SQL/Mongo's `OpFactoryCall` machinery. IDB's `IdbMigration.operations` already returns plain `IdbDdlOp[]` values directly (see the existing baseline `migration.ts`, which calls `createObjectStoreOp(...)` literally inline) — there's no separate "render the call as TypeScript source" step to begin with, because the author's own hand-typed source _is_ the rendering. That machinery exists for SQL/Mongo because their migrations are sometimes auto-generated from a diff; since this op is never auto-generated, there's nothing to render.
- **No arbitrary predicate/filter on which records within a store get transformed.** Every `transformRecords` op walks the entire store. A conditional transform (e.g. "only rows where `x` is null") isn't covered by this ADR — it would need its own op or a `when` clause on `TransformRecordsOp`, deferred until a real use case shows up.
- **No `fn.toString()`/`eval` escape hatch, not even as an opt-in "advanced" mode.** Considered and rejected outright (see Context) — it would undermine the one invariant this whole design exists to preserve.

## Open questions for review

- Should `transformRecords` (an `operationClass: "data"` op) be subject to any policy gate at authoring or preflight time, the way `"destructive"` ops implicitly are treated with more caution elsewhere? Right now nothing in `migration plan`'s `allowedOperationClasses` check actually applies to this op, since it's spliced into `operations` by hand _after_ planning, not produced by the planner — worth deciding whether `preflight` should require some explicit acknowledgment (e.g. a `--allow-data-ops` flag) before treating a chain containing one as valid.
- Should `coerce`'s throwing behavior on unparseable input be configurable per-call (e.g. an optional `onInvalid: "throw" | "skip"`), or is "always throw, always abort the transaction" the right permanent default? This ADR takes the stricter position; it's easy to loosen later, hard to tighten after someone's depended on silent skipping.

## Related

- ADR 002 — Two-Phase Migration (the `upgradeneeded`/marker-write split `transformRecords` runs inside)
- ADR 005 — Event-Driven Execution: No async/await Inside IDB Transactions (the constraint this op's cursor-walk implementation must follow, and the `runOpsSequentially()` pattern it mirrors)
- ADR 008 — Two Migration Paths (Path B, the hand-authorable/git-tracked path this op is exclusively authored through)
- ADR 011 — No Migration Materialization for IDB Extensions (`--space` authoring applies identically to a migration containing this op)
- `target-idb/src/core/schema-diff.ts` — `diffIdbSchema`, confirmed field-type-blind by design; this ADR does not change that
- `target-idb/src/core/apply-ddl-op.ts` — `applyOneDdlOp`, `openAndUpgrade`; both change shape per "Execution model" above
- `family-idb/src/core/preflight.ts` — `applyPackage`; same shape change
- `family-idb/src/core/migration-plan.ts` — `allowedOperationClasses` already includes `"data"`, previously unused
- `vendor/prisma-next/packages/1-framework/1-core/framework-components/src/control/control-migration-types.ts` — upstream `MigrationOperationClass`, the framework-level slot this ADR finally fills for IDB
- `vendor/prisma-next/packages/3-targets/3-targets/postgres/src/core/migrations/operations/data-transform.ts`, `packages/3-mongo-target/1-mongo-target/src/core/migration-factories.ts` — the sibling-target precedent this design's "closure lowers to inert data" shape is grounded in
- `sync-extension-idb/src/contract.ts`, `outbox-store.ts` — `OutboxEvent.synced`, the motivating case
