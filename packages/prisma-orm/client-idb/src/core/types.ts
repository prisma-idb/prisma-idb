import type { Contract, ContractModelBase, ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type {
  ExtractIdbFieldInputTypes,
  ExtractIdbFieldOutputTypes,
  IdbKeyPath,
  IdbModelStorage,
  IdbStorage,
} from "@prisma-idb/target-idb/pack";

// Key comparison lives in target-idb so adapter-idb's filter evaluator can
// share it. Re-exported here for the modules and public exports that already
// import it from this file.
export { fieldValueToken, fieldValuesEqual, isValidIdbKey, keyEquals, keyToken } from "@prisma-idb/target-idb/runtime";

// Re-export so consumers that only import from client-idb don't need a
// separate target-idb dependency.
export type { IdbKeyPath };

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
 * The union of a model's `keyPath` field name(s), extracted from
 * `contract.models[ModelName].storage.keyPath`. For a single-field key this
 * is just that field name; for a compound key it's the union of every member
 * field name (NOT an ordered tuple — see {@link ModelKeyPathOrdered} for the
 * order-preserving form `KeyType` needs).
 *
 * A plain union is what `Omit`/`Pick` need, where order doesn't matter.
 */
export type ModelKeyPath<TContract, ModelName extends string> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends { storage: { keyPath: infer P } }
    ? P extends string
      ? P
      : P extends readonly string[]
        ? P[number]
        : never
    : never
  : never;

/**
 * Like {@link ModelKeyPath}, but preserves declaration order as a tuple
 * (`readonly ["a", "b"]`, not the unioned `"a" | "b"`). A single-field key is
 * normalized to a 1-tuple (`readonly ["id"]`) so `KeyType` below can branch
 * on tuple shape uniformly. Needed because `findUnique`/`delete` accept the
 * key as a positional array for compound-key models (mirroring the
 * `IDBValidKey` array form IDB itself expects — see ADR-tracked decision in
 * Phase 9.1), which requires order, unlike `ModelKeyPath`'s Omit/Pick usage.
 */
export type ModelKeyPathOrdered<TContract, ModelName extends string> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends { storage: { keyPath: infer P } }
    ? P extends string
      ? readonly [P]
      : P extends readonly string[]
        ? P
        : never
    : never
  : never;

/** Maps an ordered tuple of key field names to their resolved output types, preserving position. */
type KeyTupleType<TContract, ModelName extends string, Fields extends readonly string[]> = {
  [I in keyof Fields]: Fields[I] extends keyof ResolvedOutputRow<TContract, ModelName>
    ? ResolvedOutputRow<TContract, ModelName>[Fields[I] & keyof ResolvedOutputRow<TContract, ModelName>]
    : IDBValidKey;
};

/**
 * `true` only when `T` is exactly `never` — the tuple-wrap defeats
 * conditional-type distributivity (without it, `never extends never ? A : B`
 * called with a naked, union-distributing `T` short-circuits to `never`
 * itself rather than evaluating `A`/`B`). Needed because `never` is also a
 * structural subtype of every other concrete type (including a 2+-element
 * tuple type), so a plain `ModelKeyPathOrdered<...> extends readonly
 * [string, string, ...string[]]` check would incorrectly match `never`
 * (the loosely-typed/no-type-maps contract case) as if it were a real
 * compound key.
 */
type IsNever<T> = [T] extends [never] ? true : false;

/**
 * TypeScript type of the primary key parameter for `findUnique()`/`delete()`.
 *
 * Single-field-key models keep today's scalar shape (e.g. `string`) — no
 * change for the common case, and untyped/loosely-typed contracts (no
 * emitted type maps — `ModelKeyPathOrdered` resolves to `never`) fall
 * through to the exact same `IDBValidKey` fallback `KeyType` always used
 * before compound keys existed. Compound-key models get an ordered tuple
 * type (e.g. `[string, Date]` for `@@id([orgId, effectiveFrom])`), matching
 * the `IDBValidKey` array IDB itself expects for a compound key-get — the
 * same value passes straight through to the driver with zero runtime
 * conversion.
 */
export type KeyType<TContract, ModelName extends string> =
  IsNever<ModelKeyPathOrdered<TContract, ModelName>> extends true
    ? ModelKeyPath<TContract, ModelName> extends keyof ResolvedOutputRow<TContract, ModelName>
      ? ResolvedOutputRow<TContract, ModelName>[ModelKeyPath<TContract, ModelName>]
      : IDBValidKey
    : ModelKeyPathOrdered<TContract, ModelName> extends readonly [infer Single extends string]
      ? Single extends keyof ResolvedOutputRow<TContract, ModelName>
        ? ResolvedOutputRow<TContract, ModelName>[Single]
        : IDBValidKey
      : KeyTupleType<TContract, ModelName, ModelKeyPathOrdered<TContract, ModelName>>;

// ── Create input ──────────────────────────────────────────────────────────────

/** The object store name for a model, extracted from `contract.domain...storage.storeName` (used to match `execution.mutations.defaults[].ref.table`). */
type ModelStoreName<TContract, ModelName extends string> = ModelName extends keyof ModelsOf<TContract>
  ? ModelsOf<TContract>[ModelName] extends { readonly storage: { readonly storeName: infer S } }
    ? S extends string
      ? S
      : never
    : never
  : never;

/** Whether the model's object store has `autoIncrement: true` in `contract.storage.stores` (set by `@default(autoincrement())`). */
type IsAutoIncrementStore<TContract, ModelName extends string> = TContract extends {
  readonly storage: { readonly stores: infer Stores };
}
  ? ModelStoreName<TContract, ModelName> extends keyof Stores
    ? Stores[ModelStoreName<TContract, ModelName>] extends { readonly autoIncrement: true }
      ? true
      : false
    : false
  : false;

/**
 * The primary key field `create()` may omit because IDB generates it: the
 * key of a *single-field*-key model whose store has `autoIncrement: true`.
 * IDB's key generator is numeric-only and never runs without
 * `autoIncrement` — an absent key then makes `add()` throw `DataError` —
 * and it can't fill a compound key (`autoIncrement` + array `keyPath` is
 * rejected). App-generated keys (`uuid()`/`cuid()`) are covered separately
 * by {@link FieldsWithCreateDefault}; any other key must be supplied.
 */
type OptionalKeyPathField<TContract, ModelName extends string> =
  IsAutoIncrementStore<TContract, ModelName> extends true
    ? ModelKeyPathOrdered<TContract, ModelName> extends readonly [infer Single extends string]
      ? Single
      : never
    : never;

/** {@link OptionalKeyPathField}, narrowed to a key that actually exists on the resolved input row (may be absent for models with no typed maps). */
type KeyPathField<TContract, ModelName extends string> = OptionalKeyPathField<TContract, ModelName> &
  keyof ResolvedInputRow<TContract, ModelName>;

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
 * Input shape for `create()`: the full input row with an `autoIncrement`
 * primary key made optional (see {@link OptionalKeyPathField}), and every
 * field with an `onCreate` execution default — including a `uuid()`/`cuid()`
 * key — also made optional. Any other key field stays required.
 */
export type CreateInput<TContract, ModelName extends string> = Omit<
  ResolvedInputRow<TContract, ModelName>,
  OptionalKeyPathField<TContract, ModelName> | FieldsWithCreateDefault<TContract, ModelName>
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
 * A single field name for the common case; an ordered array of field names
 * for a compound primary key.
 *
 * @throws if the model is unknown or its storage has no `keyPath` — a
 * validated contract always has one, so this only fires on a malformed or
 * hand-built contract, where guessing a key name would silently read/write
 * the wrong key.
 */
export function getKeyPath(contract: IdbContract, modelName: string): IdbKeyPath {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const keyPath = (model?.storage as IdbModelStorage | undefined)?.keyPath;
  if (keyPath === undefined) {
    throw new Error(`Model "${modelName}" has no storage.keyPath in the contract.`);
  }
  return keyPath;
}

/**
 * Extracts a row's primary key as an {@link IDBValidKey} — the scalar value
 * at `row[keyPath]` for a single-field key, or an ordered array of the
 * compound key's member field values (matching the array form IDB itself
 * expects for a compound `keyPath`). The one construction site every
 * key-get/put/delete/update call should route through, so compound-key field
 * order stays consistent everywhere.
 */
export function extractKeyFromRow(row: Record<string, unknown>, keyPath: IdbKeyPath): IDBValidKey {
  if (typeof keyPath === "string") return row[keyPath] as IDBValidKey;
  return keyPath.map((field) => row[field]) as IDBValidKey;
}

/**
 * Find the IDB index name for `fieldName` on the given object store, searching
 * `contract.storage.stores[storeName].indexes` by `keyPath` equality.
 *
 * Returns the index name (e.g. `"byEmail"`) when a single-field index whose
 * `keyPath` equals `fieldName` exists, or `undefined` otherwise.
 * Compound (array-`keyPath`) and multi-entry indexes are skipped — the
 * equality-acceleration path this map feeds (`query-shaping.ts`) only peels
 * off a single-field `eq` condition, so a compound index can't be point-range
 * queried from a single field alone. Whether/how to accelerate a compound
 * index (matching *all* its member fields against an AND'd filter) is a
 * cost-based planner decision, deferred to Phase 10.
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
