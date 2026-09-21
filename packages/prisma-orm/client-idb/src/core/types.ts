import type { Contract, ContractModelBase, ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type {
  ExtractIdbFieldInputTypes,
  ExtractIdbFieldOutputTypes,
  IdbModelStorage,
  IdbStorage,
} from "@prisma-idb/target-idb/pack";

// Re-export for consumers who only import from client-idb
export type { IdbStorage };

// ── Model-map extraction (v0.12.0 domain plane) ───────────────────────────────

/**
 * Extract the model map from a contract by traversing the domain namespace.
 *
 * 0.14.0: `Contract` dropped the 2nd `TModels` type parameter; models are now
 * accessed via `domain.namespaces[ns].models`. For a single-namespace contract
 * (the only IDB case) this resolves to the typed model map; falls back to
 * `Record<string, ContractModelBase>` for un-typed/multi-namespace inputs.
 */
type ModelsOf<TContract> = TContract extends { readonly domain: { readonly namespaces: infer NS } }
  ? NS[keyof NS] extends { readonly models: infer M }
    ? M extends Record<string, ContractModelBase>
      ? M
      : Record<string, ContractModelBase>
    : Record<string, ContractModelBase>
  : Record<string, ContractModelBase>;

// ── IdbContract convenience alias ─────────────────────────────────────────────

/**
 * A `Contract` narrowed to the IDB storage shape. Accepts any contract whose
 * `storage` block includes an `stores` record, regardless of the model set or
 * whether type maps are attached.
 */
export type IdbContract = Contract<IdbStorage>;

// ── Row type resolution (full type-maps path) ─────────────────────────────────

/**
 * Resolve the output row type for a model from the contract's type maps.
 *
 * When `fieldOutputTypes` is parameterised (the emitted contract carries
 * `IdbContractWithTypeMaps<Base, IdbTypeMaps<Codecs, FieldOutputTypes, ...>>`),
 * each field gets the exact TypeScript type emitted by the family (e.g. `Date`
 * for `idb/date@1`).
 *
 * Falls back to `Record<string, unknown>` when type maps are absent (plain
 * `IdbContract` or when the model name is not in the type maps).
 */
// FieldOutputTypes = { __unbound__: { User: {...} } } — union over namespace values
// to get the flat model map, then look up ModelName.
type NsFieldOutputTypes<TContract> = ExtractIdbFieldOutputTypes<TContract>[keyof ExtractIdbFieldOutputTypes<TContract>];

type ResolvedOutputRow<TContract, ModelName extends string> = string extends keyof ExtractIdbFieldOutputTypes<TContract>
  ? Record<string, unknown>
  : NsFieldOutputTypes<TContract> extends Record<string, unknown>
    ? ModelName extends keyof NsFieldOutputTypes<TContract>
      ? { -readonly [K in keyof NsFieldOutputTypes<TContract>[ModelName]]: NsFieldOutputTypes<TContract>[ModelName][K] }
      : Record<string, unknown>
    : Record<string, unknown>;

/**
 * Resolve the input row type for a model from the contract's type maps.
 *
 * Mirrors `ResolvedOutputRow` but uses `fieldInputTypes` — the input types
 * used for `create()`, `where()`, and mutation payloads.
 */
type NsFieldInputTypes<TContract> = ExtractIdbFieldInputTypes<TContract>[keyof ExtractIdbFieldInputTypes<TContract>];

type ResolvedInputRow<TContract, ModelName extends string> = string extends keyof ExtractIdbFieldInputTypes<TContract>
  ? Record<string, unknown>
  : NsFieldInputTypes<TContract> extends Record<string, unknown>
    ? ModelName extends keyof NsFieldInputTypes<TContract>
      ? { -readonly [K in keyof NsFieldInputTypes<TContract>[ModelName]]: NsFieldInputTypes<TContract>[ModelName][K] }
      : Record<string, unknown>
    : Record<string, unknown>;

// ── Public row types ──────────────────────────────────────────────────────────

/** The full TypeScript row shape returned by `all()`, `first()`, and `create()`. */
export type DefaultModelRow<TContract, ModelName extends string> = ResolvedOutputRow<TContract, ModelName>;

// ── Where filter ──────────────────────────────────────────────────────────────

/**
 * Partial equality filter applied as an in-memory predicate during cursor scans.
 *
 * All fields are optional — only provided fields are checked. Values use the
 * output types (from `fieldOutputTypes`) since the values are compared against
 * decoded row data.
 */
export type WhereFilter<TContract, ModelName extends string> = {
  readonly [K in keyof DefaultModelRow<TContract, ModelName>]?: DefaultModelRow<TContract, ModelName>[K];
};

// ── KeyPath / KeyType ─────────────────────────────────────────────────────────

/**
 * The literal `keyPath` string for a model, extracted from
 * `contract.models[ModelName].storage.keyPath`.
 *
 * Used at the type level to exclude the key field from `CreateInput` and to
 * narrow the `findUnique` / `delete` key parameter type.
 */
export type ModelKeyPath<TContract, ModelName extends string> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends { storage: { keyPath: infer P } }
    ? P extends string
      ? P
      : never
    : never
  : never;

/**
 * TypeScript type of the primary key field for a given model.
 *
 * When the output row type has a field matching `ModelKeyPath`, that field's
 * type is used. Otherwise falls back to `IDBValidKey` (the DOM union of valid
 * IDB key types).
 */
export type KeyType<TContract, ModelName extends string> =
  ModelKeyPath<TContract, ModelName> extends keyof ResolvedOutputRow<TContract, ModelName>
    ? ResolvedOutputRow<TContract, ModelName>[ModelKeyPath<TContract, ModelName>]
    : IDBValidKey;

// ── Create input ──────────────────────────────────────────────────────────────

/** The keyPath field when it exists in the resolved input row (may be absent for models with no typed maps). */
type KeyPathField<TContract, ModelName extends string> = ModelKeyPath<TContract, ModelName> &
  keyof ResolvedInputRow<TContract, ModelName>;

/** The object store name for a model, extracted from `contract.domain...storage.storeName` (used to match `execution.mutations.defaults[].ref.table`). */
type ModelStoreName<TContract, ModelName extends string> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends { readonly storage: { readonly storeName: infer S } }
    ? S extends string
      ? S
      : never
    : never
  : never;

/** The flattened `execution.mutations.defaults` array type, or `never` for a contract with no execution section. */
type ExecutionDefaultsOf<TContract> = TContract extends {
  readonly execution: { readonly mutations: { readonly defaults: infer D } };
}
  ? D extends readonly unknown[]
    ? D[number]
    : never
  : never;

/**
 * Column names with an `onCreate` execution default for this model's store —
 * e.g. `temporal.updatedAt()`/bare `@updatedAt` fields, or any
 * `@default(...)` field (literal, `now()`, `uuid()`, `cuid()`). These are
 * omittable in `create()` even though the field itself isn't nullable,
 * since the runtime fills them in (`client-idb/src/core/mutation-defaults.ts`).
 */
type FieldsWithCreateDefault<TContract, ModelName extends string> = Extract<
  ExecutionDefaultsOf<TContract>,
  { readonly ref: { readonly table: ModelStoreName<TContract, ModelName> }; readonly onCreate: unknown }
>["ref"]["column"];

/** {@link FieldsWithCreateDefault}, narrowed to keys that actually exist on the resolved input row (may be absent for models with no typed maps). */
type DefaultedInputField<TContract, ModelName extends string> = FieldsWithCreateDefault<TContract, ModelName> &
  keyof ResolvedInputRow<TContract, ModelName>;

/**
 * Input shape for `create()`: the full input row with the primary key field
 * made optional (IDB can generate keys via `autoIncrement`, or clients may
 * omit the key when using `cuid()` / `uuid()` at the application layer), and
 * every other field with an `onCreate` execution default also made optional.
 */
export type CreateInput<TContract, ModelName extends string> = Omit<
  ResolvedInputRow<TContract, ModelName>,
  ModelKeyPath<TContract, ModelName> | FieldsWithCreateDefault<TContract, ModelName>
> &
  Partial<
    Pick<
      ResolvedInputRow<TContract, ModelName>,
      KeyPathField<TContract, ModelName> | DefaultedInputField<TContract, ModelName>
    >
  >;

// ── Relations ─────────────────────────────────────────────────────────────────

/** Extract the relations record for a model. */
type ModelRelations<TContract, ModelName extends string> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends { relations: infer R }
    ? R extends Record<string, unknown>
      ? R
      : Record<string, never>
    : Record<string, never>
  : Record<string, never>;

/**
 * Union of relation keys on a model that are `ContractReferenceRelation`s
 * (i.e. cross-store joins, not embedded documents).
 *
 * Used to constrain the `include()` method's `relation` parameter to only
 * valid reference relation names.
 */
export type ReferenceRelKeys<TContract, ModelName extends string> = {
  [K in keyof ModelRelations<TContract, ModelName>]: ModelRelations<
    TContract,
    ModelName
  >[K] extends ContractReferenceRelation
    ? K
    : never;
}[keyof ModelRelations<TContract, ModelName>] &
  string;

/**
 * TypeScript row type for an included relation.
 *
 * - `1:N` cardinality → `RelatedRow[]`
 * - `N:1` or `1:1` cardinality → `RelatedRow | null`
 */
type RelationRowType<TContract, ModelName extends string, RelKey extends string> = RelKey extends keyof ModelRelations<
  TContract,
  ModelName
>
  ? ModelRelations<TContract, ModelName>[RelKey] extends ContractReferenceRelation
    ? ModelRelations<TContract, ModelName>[RelKey] extends {
        to: { model: infer To extends string };
        cardinality: infer C;
      }
      ? C extends "1:N"
        ? DefaultModelRow<TContract, To>[]
        : DefaultModelRow<TContract, To> | null
      : never
    : never
  : never;

/**
 * Per-relation include marker tracked at the type level.
 *
 * - `true` — the relation is loaded as rows (array for `1:N`, single/null
 *   otherwise), optionally refined by a `where`/`orderBy`/`take` callback.
 * - `"scalar"` — the relation is reduced to a `count()` (Phase 6.5), so the
 *   row field becomes a `number` instead of related rows.
 */
export type IncludeMarker = true | "scalar";

/** Which relations are included in the current accessor chain. */
export type IncludeSpec<TContract, ModelName extends string> = Partial<
  Record<ReferenceRelKeys<TContract, ModelName>, IncludeMarker>
>;

/** Empty include spec — no relations included. */
export type NoIncludes = Record<never, never>;

/**
 * The relation fields contributed by a set of `.include()` calls.
 *
 * A key is added only when its `TIncludes` marker is set; the field type is
 * `number` for a scalar `count()` include and the cardinality-shaped related
 * row(s) otherwise. Split out from {@link IncludedRow} so {@link SelectedRow}
 * can re-use it on top of a projected (picked) scalar base.
 */
export type IncludeFields<TContract, ModelName extends string, TIncludes extends IncludeSpec<TContract, ModelName>> = {
  -readonly [
    K in keyof TIncludes & string as TIncludes[K] extends IncludeMarker ? K : never
  ]: TIncludes[K] extends "scalar" ? number : RelationRowType<TContract, ModelName, K>;
};

/**
 * A row type that merges the base model row with any included relation fields.
 *
 * The extra fields are only added when the corresponding key in `TIncludes` is
 * set, so the type stays narrow until `.include()` is called.
 */
export type IncludedRow<
  TContract,
  ModelName extends string,
  TIncludes extends IncludeSpec<TContract, ModelName>,
> = DefaultModelRow<TContract, ModelName> & IncludeFields<TContract, ModelName, TIncludes>;

/**
 * The row type after an optional `.select()` projection.
 *
 * When `TSelected` is `never` (no `.select()` call) the full {@link IncludedRow}
 * is returned. Otherwise the scalar base is narrowed to the picked fields, with
 * any included relation fields preserved (mirrors the vendor `select()` which
 * keeps relations and narrows only scalar columns).
 */
export type SelectedRow<
  TContract,
  ModelName extends string,
  TIncludes extends IncludeSpec<TContract, ModelName>,
  TSelected extends string,
> = [TSelected] extends [never]
  ? IncludedRow<TContract, ModelName, TIncludes>
  : Pick<DefaultModelRow<TContract, ModelName>, TSelected & keyof DefaultModelRow<TContract, ModelName>> &
      IncludeFields<TContract, ModelName, TIncludes>;

// ── Patch input ───────────────────────────────────────────────────────────────

/**
 * Partial update shape for `update()`, `updateAll()`, `updateCount()`, and the
 * `update` arm of `upsert()`. All fields are optional — only provided fields
 * are shallow-merged onto the existing record.
 */
export type PatchInput<TContract, ModelName extends string> = Partial<DefaultModelRow<TContract, ModelName>>;

// ── Relation mutation types ───────────────────────────────────────────────────

/** Extracts the `to` model name for a named relation on a model. */
export type RelatedModelOf<
  TContract,
  ModelName extends string,
  RelName extends string,
> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends {
      relations: Record<RelName, { to: { model: infer To extends string } }>;
    }
    ? To
    : string
  : string;

/** Nested-create descriptor: insert one or more related records. */
export interface RelationMutationCreate<TContract, ModelName extends string> {
  readonly kind: "create";
  readonly data: readonly CreateInput<TContract, ModelName>[];
}

/** Nested-connect descriptor: link existing records to the parent via FK update. */
export interface RelationMutationConnect {
  readonly kind: "connect";
  readonly criteria: readonly Record<string, unknown>[];
}

/**
 * Nested-disconnect descriptor: unlink related records by setting FK to null.
 * With no criteria, disconnects all child records from this parent.
 */
export interface RelationMutationDisconnect {
  readonly kind: "disconnect";
  readonly criteria?: readonly Record<string, unknown>[];
}

/** Discriminated union of all nested relation mutation descriptors. */
export type IdbRelationMutation<TContract, ModelName extends string> =
  RelationMutationCreate<TContract, ModelName> | RelationMutationConnect | RelationMutationDisconnect;

/** Relation mutator object passed to the user's relation callback. */
export interface IdbRelationMutator<TContract, ModelName extends string> {
  create(
    data: CreateInput<TContract, ModelName> | readonly CreateInput<TContract, ModelName>[]
  ): RelationMutationCreate<TContract, ModelName>;
  connect(criteria: Record<string, unknown> | readonly Record<string, unknown>[]): RelationMutationConnect;
  disconnect(criteria?: readonly Record<string, unknown>[]): RelationMutationDisconnect;
}

/**
 * Maps each reference relation key to an optional mutation callback.
 *
 * When `ReferenceRelKeys` widens to `string` (a loosely-typed `IdbContract`
 * with no emitted type maps), a naive mapped type would become an index
 * signature `{ [k: string]: callback }` that incorrectly forces *every* field —
 * scalars included — to be a relation callback, so even `create({ name: "x" })`
 * would fail to type-check. The `string extends …` guard detects that case and
 * contributes no constraint (`& unknown` is identity), leaving plain scalar
 * payloads valid. Precisely-typed contracts (the emitted `contract.d.ts`)
 * resolve `ReferenceRelKeys` to a finite union and get the full callback typing.
 */
type RelationMutationFields<TContract, ModelName extends string> =
  string extends ReferenceRelKeys<TContract, ModelName>
    ? unknown
    : Partial<{
        [K in ReferenceRelKeys<TContract, ModelName>]: (
          mutator: IdbRelationMutator<TContract, RelatedModelOf<TContract, ModelName, K>>
        ) => IdbRelationMutation<TContract, RelatedModelOf<TContract, ModelName, K>>;
      }>;

/**
 * The `localFields` of all N:1 relations on a model — the FK fields that are
 * owned by this model and can be supplied via a relation callback instead of
 * as a scalar value. Resolves to `never` for loosely-typed contracts where
 * cardinality is not preserved as a literal (e.g. `defineContract` in tests).
 *
 * Mirrors `ChildForeignKeyFieldNames` from `sql-orm-client`, simplified: instead
 * of crawling all models for relations pointing *to* this one, we look at this
 * model's own N:1 relations directly — same field set, one model.
 */
type N1LocalFieldNames<TContract, ModelName extends string> = {
  [K in keyof ModelRelations<TContract, ModelName>]: ModelRelations<TContract, ModelName>[K] extends {
    readonly cardinality: "N:1";
    readonly on: { readonly localFields: infer Fields extends readonly string[] };
  }
    ? Fields[number]
    : never;
}[keyof ModelRelations<TContract, ModelName>] &
  string;

/**
 * Like `CreateInput` but with N:1 FK fields made optional.
 *
 * An N:1 FK field (e.g. `authorId` on `Post`) can be supplied either as a
 * scalar value or via a relation callback (`author: (rel) => rel.connect({id})`).
 * Making it optional here lets callers omit it when using the callback form —
 * the executor populates it from the related record before inserting.
 *
 * Mirrors `NestedCreateInput` from `sql-orm-client`.
 */
type NestedCreateInput<TContract, ModelName extends string> = Omit<
  CreateInput<TContract, ModelName>,
  N1LocalFieldNames<TContract, ModelName>
> &
  Partial<
    Pick<
      CreateInput<TContract, ModelName>,
      N1LocalFieldNames<TContract, ModelName> & keyof CreateInput<TContract, ModelName>
    >
  >;

/**
 * Input shape for `create()` with optional relation callbacks.
 * N:1 FK fields (e.g. `authorId`) are optional when using a relation callback.
 * Relation fields accept a callback `(rel) => rel.create([...])` / `rel.connect(...)`.
 */
export type MutationCreateInput<TContract, ModelName extends string> = NestedCreateInput<TContract, ModelName> &
  RelationMutationFields<TContract, ModelName>;

/**
 * Input shape for `update()` with optional relation callbacks.
 * All scalar fields are optional (shallow merge); relation fields accept
 * `connect` or `disconnect` callbacks.
 */
export type MutationUpdateInput<TContract, ModelName extends string> = PatchInput<TContract, ModelName> &
  RelationMutationFields<TContract, ModelName>;

// ── OrderBy spec ─────────────────────────────────────────────────────────────

/** Sort direction for `orderBy()`. */
export type SortDirection = "asc" | "desc";

/** Partial sort spec: field name → direction. */
export type OrderBySpec<TContract, ModelName extends string> = Partial<
  Record<string & keyof DefaultModelRow<TContract, ModelName>, SortDirection>
>;

// ── Aggregate / groupBy ───────────────────────────────────────────────────────

/** The five aggregation functions, matching the vendor `AggregateFn`. */
export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

/**
 * Fields eligible for numeric aggregation (`sum`/`avg`/`min`/`max`).
 *
 * For an emitted (precisely-typed) contract this narrows to the fields whose
 * output type is assignable to `number`. For a loosely-typed `IdbContract`
 * (no type maps — `DefaultModelRow` is `Record<string, unknown>`) the row key
 * set widens to `string`, so we allow any field name rather than collapsing to
 * `never`. Mirrors `NumericFieldNames` from `sql-orm-client`, trait-free.
 */
export type NumericFieldNames<TContract, ModelName extends string> = string extends keyof DefaultModelRow<
  TContract,
  ModelName
>
  ? string
  : {
      [K in keyof DefaultModelRow<TContract, ModelName> & string]: NonNullable<
        DefaultModelRow<TContract, ModelName>[K]
      > extends number
        ? K
        : never;
    }[keyof DefaultModelRow<TContract, ModelName> & string];

declare const idbAggregateResultBrand: unique symbol;

/**
 * A single aggregation selector produced by the {@link IdbAggregateBuilder}.
 *
 * The phantom `Result` brand carries the per-selector result type so
 * {@link IdbAggregateResult} can map each alias back to its value type.
 * Mirrors the vendor `AggregateSelector`.
 */
export interface IdbAggregateSelector<Result> {
  readonly kind: "aggregate";
  readonly fn: AggregateFn;
  readonly field?: string;
  readonly [idbAggregateResultBrand]?: Result;
}

/** A map of result aliases → aggregation selectors (the `aggregate()` spec). */
export type IdbAggregateSpec = Record<string, IdbAggregateSelector<unknown>>;

/** The result row shape for an {@link IdbAggregateSpec}: alias → value type. */
export type IdbAggregateResult<Spec extends IdbAggregateSpec> = {
  [K in keyof Spec]: Spec[K] extends IdbAggregateSelector<infer Result> ? Result : never;
};

/**
 * The builder handed to an `.aggregate(agg => …)` callback. `count()` is always
 * available; the field reducers are constrained to {@link NumericFieldNames}.
 * Mirrors the vendor `AggregateBuilder`, minus the SQL column mapping.
 */
export interface IdbAggregateBuilder<TContract, ModelName extends string> {
  count(): IdbAggregateSelector<number>;
  sum<F extends NumericFieldNames<TContract, ModelName>>(field: F): IdbAggregateSelector<number | null>;
  avg<F extends NumericFieldNames<TContract, ModelName>>(field: F): IdbAggregateSelector<number | null>;
  min<F extends NumericFieldNames<TContract, ModelName>>(field: F): IdbAggregateSelector<number | null>;
  max<F extends NumericFieldNames<TContract, ModelName>>(field: F): IdbAggregateSelector<number | null>;
}

// ── Model storage helpers ─────────────────────────────────────────────────────

/**
 * Extract the `storeName` from a model's storage metadata at runtime.
 * Falls back to the model name if `storeName` is absent.
 */
export function getStoreName(contract: IdbContract, modelName: string): string {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  return (model?.storage as IdbModelStorage | undefined)?.storeName ?? modelName;
}

/**
 * Extract the `keyPath` from a model's storage metadata at runtime.
 * Falls back to `"id"` (the invariant key name for all syncable IDB models).
 */
export function getKeyPath(contract: IdbContract, modelName: string): string {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  return (model?.storage as IdbModelStorage | undefined)?.keyPath ?? "id";
}

/**
 * Find the IDB index name for `fieldName` on the given object store, searching
 * `contract.storage.stores[storeName].indexes` by `keyPath` equality.
 *
 * Returns the index name (e.g. `"byEmail"`) when a single-field index whose
 * `keyPath` equals `fieldName` exists, or `undefined` otherwise.
 * Multi-entry and composite indexes (`keyPath` is an array) are skipped —
 * equality semantics on those are unsupported.
 */
export function getIndexForField(contract: IdbContract, storeName: string, fieldName: string): string | undefined {
  return buildFieldToIndexMap(contract, storeName)[fieldName];
}

/**
 * Build a field → indexName lookup for every single-field, non-multi-entry
 * index on `storeName`. Shared by {@link getIndexForField} (relation loader,
 * single-field lookups) and {@link IdbStoreAccessorImpl} (top-level scans,
 * which need the whole map to probe combined filter expressions).
 */
export function buildFieldToIndexMap(contract: IdbContract, storeName: string): Record<string, string> {
  const storeDef = contract.storage.stores[storeName];
  const result: Record<string, string> = {};
  if (storeDef?.indexes === undefined) return result;
  for (const [indexName, indexDef] of Object.entries(storeDef.indexes)) {
    if (typeof indexDef.keyPath === "string" && indexDef.multiEntry !== true) {
      result[indexDef.keyPath] = indexName;
    }
  }
  return result;
}

/**
 * Returns `true` when `value` is a valid {@link IDBValidKey} — i.e. a value
 * that can be passed to `IDBKeyRange.only()` without throwing a DataError.
 * Booleans, `NaN`, `BigInt`, plain objects, and `null`/`undefined` are not
 * valid IDB keys (only number/string/Date/binary/Array are, per the
 * IndexedDB spec). Arrays are validated recursively — an array containing
 * any invalid element (e.g. a nested boolean) is itself not a valid key.
 *
 * Shared by the relation loader (filtering FK values before building
 * `IDBKeyRange.only()` plans) and query-shaping (gating `eq` conditions for
 * index/PK point-range acceleration).
 */
export function isValidIdbKey(value: unknown): value is IDBValidKey {
  if (typeof value === "number") return !Number.isNaN(value);
  if (typeof value === "string") return true;
  if (value instanceof Date) return true;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) return value.every((v) => isValidIdbKey(v));
  return false;
}

/**
 * Resolve a model's named relation to a {@link ContractReferenceRelation} at
 * runtime, or `undefined` when the relation is absent or an embedded relation
 * (no `on` join block). Used by `include()` to find the related model name and
 * cardinality before building the child-accessor refinement.
 */
export function getRelation(
  contract: IdbContract,
  modelName: string,
  relName: string
): ContractReferenceRelation | undefined {
  const relation = domainModelsAtDefaultNamespace(contract.domain)[modelName]?.relations?.[relName];
  if (relation === undefined || !("on" in relation)) return undefined;
  return relation as ContractReferenceRelation;
}
