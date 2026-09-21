# ADR 009 — FK Validation and Referential Action Enforcement in IDB

## Context

IndexedDB is a key-value store with no native FK constraint mechanism. There is no `ON DELETE CASCADE` at the engine level — orphaned FK references are silently permitted. This is the same situation MongoDB is in. SQL targets in the framework sidestep the problem entirely: they generate DDL `ON DELETE …` clauses and let the database engine enforce referential integrity.

The framework's base `ContractReferenceRelation` type carries only join metadata (`to`, `cardinality`, `on: { localFields, targetFields }`). There is no `onDelete` or `onUpdate` field. This is intentional — the contract IR is storage-agnostic; referential actions are a storage-layer concern. For SQL targets, `onDelete` lives in the SQL storage layer's FK metadata (`fk: { onDelete: 'cascade' }` in `SqlModelStorage`). IDB needs its own equivalent.

Two separate gaps existed before this decision:

1. **Scalar FK writes were not validated.** `db.posts.create({ userId: "nonexistent" })` succeeded silently with a dangling FK. Only the nested write `connect()` path validated FK existence.

2. **`delete()` had no referential action enforcement.** Deleting a parent left all child records with dangling FK values pointing to a non-existent record.

## Decision

### 1. Store referential action metadata in `IdbModelStorage`

Add a `relations` field to `IdbModelStorage` (in `target-idb/src/core/idb-contract-types.ts`):

```ts
export type IdbReferentialAction = "cascade" | "setNull" | "setDefault" | "restrict" | "noAction";

export type IdbRelationStorage = {
  readonly onDelete?: IdbReferentialAction; // default: 'restrict'
};

export type IdbModelStorage = {
  readonly storeName: string;
  readonly keyPath: string;
  readonly relations?: Record<string, IdbRelationStorage>;
};
```

(As originally decided — see the "Consequences" section below for the shipped shape: `IdbRelationStorage` also gained `onUpdate?`, and `IdbModelStorage` gained `fieldDefaults?: Record<string, string | number | boolean>` to back `setDefault`.)

This mirrors the SQL pattern: FK behavior lives in target-specific storage metadata, not in the target-agnostic contract IR. The `relations` key matches the relation name in `model.relations` so the ORM can cross-reference them.

`RelationDef` in `family-idb/src/core/contract-builder.ts` gains an optional `onDelete?` field, and `defineContract()` writes it into `IdbModelStorage.relations` at contract build time.

### 2. Enforce FK existence on all mutation paths (not just `connect()`)

Scalar creates and updates that set FK fields (N:1 relation `localFields` that are present in the write payload) are validated inside a `withMutationScope` transaction:

- Collect all N:1 relations on the model where `localFields` intersect with the write payload and the value is non-null.
- For each, scan the related store for a matching record.
- If not found, abort the transaction with a descriptive error.

When no FK fields are being written (no N:1 relations or all FK fields are null/absent), the existing plain `put` path runs unchanged — no overhead.

### 3. Enforce referential actions on `delete()` / `deleteAll()` / `deleteCount()`

When a delete is requested, walk the contract's relations to find all child models (1:N relations where the child's `localFields` point to the deleting model's `keyPath`). For each, read `IdbModelStorage.relations[relName].onDelete`:

| Action               | Behaviour                                                                               |
| -------------------- | --------------------------------------------------------------------------------------- |
| `cascade`            | Delete all matching child records in the same multi-store transaction                   |
| `setNull`            | Update all matching children: set the FK field(s) to `null`                             |
| `setDefault`         | Update all matching children: set the FK field(s) to their default values               |
| `restrict` (default) | Abort if any matching children exist; throw a descriptive error                         |
| `noAction`           | Proceed without touching child records — caller accepts responsibility for orphaned FKs |

All actions run inside a single `withMutationScope` transaction spanning the parent and all affected child stores, collected at parse time from the contract relation graph — the same mechanism Phase 6.4 uses for nested writes.

## Why `IdbModelStorage` and not `ContractReferenceRelation`

The framework's `ContractReferenceRelation` is owned by the framework package and shared across all families and targets. Adding `onDelete` there would either require upstreaming an IDB-specific concept to the framework, or creating a divergent fork of the type. Both are wrong.

`IdbModelStorage` is the IDB target's own storage metadata — it already holds `storeName` and `keyPath` (IDB-specific fields that have no SQL equivalent). Adding relation storage metadata there is the correct layering: the IDB target describes how its storage behaves, parallel to how `SqlModelStorage` describes SQL FK constraint behaviour.

## Why enforce on all mutation paths

`connect()` already validates FK existence because the nested write executor looks up the referenced row. But scalar writes bypass the nested write executor entirely — `db.posts.create({ userId: "..." })` issues a plain `put`. A user writing directly to FK fields gets no safety without this change.

The contract has all the information needed: N:1 relations declare exactly which local fields are FK fields and which target model/store they reference.

## Consequences

- **Default action is `restrict`** — a delete that would orphan child records throws by default. Callers must explicitly opt in to `'cascade'`, `'setNull'`, or `'noAction'`; silence never permits dangling FKs.
- **`onDelete: 'noAction'` explicitly disables enforcement.** Use when the caller accepts responsibility for orphaned records (e.g. soft-delete patterns, deferred cleanup).
- **Specifying `onDelete: 'cascade'` makes deletes self-cleaning.** The delete automatically propagates to child records in the same transaction.
- **`deleteAll()` and `deleteCount()`** apply referential actions per deleted row inside the same multi-store `withMutationScope` transaction.
- **Scalar FK validation adds a read per N:1 relation per write** when FK fields are being set. This is minimal overhead given IDB's in-process, in-memory-backed execution model.
- **Recursive (multi-hop) cascade is implemented.** `applyReferentialActionsForRow` reads each matched child, recurses into that child's own `onDelete` relations, then deletes it — so a chain like `User --cascade--> Post --cascade--> Comment` is fully torn down, not just the first hop. `collectDeleteStoreNames` walks the same cascade edges transitively to declare every store the transaction might touch up front (a hard IDB requirement). Both walks are cycle-safe (model-level guard for the static store collector, row-level guard for the row executor), so a self-referential or mutually-cascading model doesn't hang or stack-overflow. `setNull`/`setDefault` remain leaf actions — the child row survives, so recursion never continues past them. One consequence: a cascade no longer collapses into a single `scan-write` outbox firing — each cascaded row is now read then deleted individually (needed so a deeper cascade can be enforced per row), so sync tracks one `outboxwrite` firing per cascaded row instead of one firing for the whole batch.
- **`onUpdate` referential actions are implemented**, mirroring `onDelete`'s storage/parsing/enforcement shape (`IdbRelationStorage.onUpdate`, `@relation(onUpdate: ...)` in PSL, `RelationDef.onUpdate` in the TS DSL). Unlike `onDelete`, `onUpdate`'s default (when neither side of a relation declares one) is `'cascade'`, matching Prisma's own documented default — propagating a changed referenced value to children is normally safe, unlike deleting the row those children point to. Enforcement only fires when a write's patch actually changes a value other relations reference (compared against the row's pre-image, not merely field presence in the patch), which required restructuring `update()`/`updateAll()`/`updateCount()` to read the matching row(s) before writing when `onUpdate` enforcement could apply — the existing blind `scan-write` fast path is unchanged when it can't. `upsert()`'s update arm gets the same enforcement; its create arm not validating scalar FKs is a pre-existing gap outside this scope (see below).
- **`setDefault` is implemented** for both `onDelete` and `onUpdate`. `IdbModelStorage.fieldDefaults` (populated only from a literal `@default(...)` — never a generator like `uuid()`/`now()`, matching Prisma's own restriction that `SetDefault` may only target a scalar default) holds each field's default value; `setDefault` resets the child's own FK field to it. A target field with no declared default throws a precise error rather than silently no-op'ing. **The default value is also validated against the parent's own store before it's written** (`validateSetDefaultPatch`) — a real database only makes `SET DEFAULT` safe because its FK constraint re-checks the new value transactionally; without an equivalent check here, `setDefault` would silently reintroduce the dangling-FK problem this whole ADR exists to close (e.g. `authorId: "system"` with no `id: "system"` row would otherwise write a dangling reference undetected). Refuses (throws) rather than validates incorrectly for compound (multi-field) relations, mirroring `validateScalarFks`'s same restriction.
- **Known gap, out of scope for this work:** `upsert()`'s _create_ arm never validates scalar FKs even on the atomic path. Predates this work and is not addressed here.
- **`upsert()` requires a transaction-capable executor unconditionally**, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally, regardless of what the write touches). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations; a plain scalar `create`/`delete` still works on a bare executor. `upsert()` previously kept a non-atomic two-step fallback for a bare `IdbQueryExecutor` (no `.transaction()`) so the `./orm` "any executor" contract held for it too — but that fallback couldn't run referential-action enforcement (it isn't a transaction), so a cascade-triggering `upsert()` on a bare executor would silently skip it. Since the project has no external consumers yet, the fallback was deleted rather than patched: `requireTransactionExecutor()` now rejects a bare executor immediately, unconditionally, same as `update`/`updateAll`/`deleteAll`. The now-unreachable plan-level `IdbUpsertAst` node was deleted for the same reason `IdbNestedCreateAst`/`IdbNestedUpdateAst` were (see the note beside `IdbQueryAst` in `adapter-idb/src/core/idb-query-ast.ts`) — `upsert()` runs entirely inside `withMutationScope`, which bypasses the plan/AST layer by design.

## Implementation — see Phase 6.8 in PLAN.md; the recursive-cascade/`onUpdate`/`setDefault` follow-up work is captured in the "Consequences" section above

## Related

- `target-idb/src/core/idb-contract-types.ts` — `IdbModelStorage`, `IdbReferentialAction` (to be added)
- `family-idb/src/core/contract-builder.ts` — `RelationDef.onDelete` (to be added)
- `client-idb/src/core/mutation-executor.ts` — scalar FK validation + delete referential action enforcement (to be added)
- `client-idb/src/core/store-accessor.ts:569` — `delete()` (to be updated)
- `vendor/.../domain-types.ts` — `ContractReferenceRelation` (framework type, read-only for us)
- SQL analog: `vendor/.../postgres/src/core/migrations/operations/constraints.ts` — `ON DELETE` DDL generation
- ADR 007 — `withMutationScope` is the transaction mechanism used for enforcement
- [PLAN.md § Phase 6.8](../../PLAN.md#phase-68--fk-validation-and-referential-action-enforcement)
