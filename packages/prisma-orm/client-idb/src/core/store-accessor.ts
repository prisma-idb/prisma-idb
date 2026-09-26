import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import type { IdbFilterExpr, IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type {
  IdbAggregateAst,
  IdbCountAst,
  IdbCreateAst,
  IdbCreateAllAst,
  IdbDeleteAst,
  IdbFindManyAst,
  IdbFindUniqueAst,
  IdbQueryAst,
} from "@prisma-idb/adapter-idb/runtime";
import { evaluateFilter, shorthandToFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import {
  type CreateInput,
  type DefaultModelRow,
  type IdbAggregateBuilder,
  type IdbAggregateResult,
  type IdbAggregateSpec,
  type IdbContract,
  type IncludeSpec,
  type KeyType,
  type MutationCreateInput,
  type MutationUpdateInput,
  type NoIncludes,
  type OrderBySpec,
  type PatchInput,
  type ReferenceRelKeys,
  type RelatedModelOf,
  type SelectedRow,
  type WhereFilter,
  buildFieldToIndexMap,
  extractKeyFromRow,
  getKeyPath,
  getRelation,
  getStoreName,
  keyToken,
} from "./types";
import { createModelAccessor, type IdbModelAccessor } from "./model-accessor";
import {
  type IdbAccessorState,
  type IdbIncludeScalar,
  type IncludeEntry,
  createIncludeScalar,
  emptyAccessorState,
  isIncludeScalar,
  mergeAccessorState,
} from "./store-state";
import {
  buildRowComparator,
  combineFilterExprs,
  clampCount,
  extractIndexEqualityHint,
  extractIndexOrHint,
  isNativelyCountable,
  toCountPlan,
  type IndexOrHint,
} from "./query-shaping";
import {
  assertValidAggregateSpec,
  computeAggregateSpec,
  createAggregateBuilder,
  toAggregateRequests,
} from "./aggregate-builder";
import { type IdbGroupedAccessor, createGroupedAccessor } from "./grouped-accessor";
import type { IdbQueryExecutor } from "./executor";
import { applyCreateDefaults, applyUpdateDefaults, createMutationDefaultsCache } from "./mutation-defaults";
import { loadRelation } from "./relation-loader";
import {
  applyReferentialActionsForRowOnUpdate,
  collectOnUpdateEnforcementStoreNames,
  collectScalarFkStoreNames,
  executeBulkUpdateWithFkValidation,
  executeDeleteAllWithReferentialActions,
  executeDeleteWithReferentialActions,
  executeNestedCreateMutation,
  executeNestedUpdateMutation,
  executeScalarCreateAllWithFkValidation,
  executeScalarCreateWithFkValidation,
  executeScalarUpdateWithFkValidation,
  hasEnforceableChildRelations,
  hasNestedMutationCallbacks,
  hasScalarFkFields,
  requireTransactionExecutor,
  validateScalarFks,
} from "./mutation-executor";
import { withMutationScope } from "./mutation-scope";

/** Callback form of `.where(fn)` — receives the typed model accessor proxy. */
export type WhereCallback<TContract, ModelName extends string> = (
  m: IdbModelAccessor<TContract, ModelName>
) => IdbFilterExpr;

/** Tuple of one-or-more field names of a model (for `select()` / `groupBy()`). */
type FieldTuple<TContract, ModelName extends string> = readonly [
  keyof DefaultModelRow<TContract, ModelName> & string,
  ...(keyof DefaultModelRow<TContract, ModelName> & string)[],
];

/**
 * The child accessor handed to an `include()` refinement callback.
 *
 * Exposes the chainable narrowing methods (`where` / `orderBy` / `take` /
 * `skip`) plus the scalar `count()` reducer. Mirrors the vendor
 * `IncludeRefinementCollection`: chainable methods return the same refinement
 * surface so `count()` stays reachable after a `where()`, and `count()` returns
 * an {@link IdbIncludeScalar} marker rather than the async terminal `count()`
 * found on the top-level accessor.
 */
export interface IdbIncludeRefinementAccessor<TContract, ModelName extends string> {
  where(
    filter: WhereFilter<TContract, ModelName> | WhereCallback<TContract, ModelName>
  ): IdbIncludeRefinementAccessor<TContract, ModelName>;
  orderBy(spec: OrderBySpec<TContract, ModelName>): IdbIncludeRefinementAccessor<TContract, ModelName>;
  take(n: number): IdbIncludeRefinementAccessor<TContract, ModelName>;
  skip(n: number): IdbIncludeRefinementAccessor<TContract, ModelName>;
  count(): IdbIncludeScalar;
}

/** Refinement callback type for a given relation key `K`. */
type IncludeRefineFn<TContract, ModelName extends string, K extends string, R> = (
  collection: IdbIncludeRefinementAccessor<TContract, RelatedModelOf<TContract, ModelName, K>>
) => R;

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Immutable query-builder for a single IDB object store.
 *
 * Each method that narrows the query (`.where()`, `.take()`, etc.) returns a
 * new, independent accessor instance — the original is never mutated. This
 * mirrors the `MongoCollection` pattern from Prisma ORM's Mongo family.
 *
 * @template TContract   - The full IDB contract (with or without type maps).
 * @template ModelName   - The model (store) this accessor targets.
 * @template TIncludes   - Tracks which relations have been included via
 *   `.include()` calls, so the return type widens progressively.
 * @template TSelected   - Field names kept by `.select()`. `never` (the
 *   default) means "all fields"; otherwise the row narrows to these fields
 *   (plus any included relations).
 */
export interface IdbStoreAccessor<
  TContract,
  ModelName extends string,
  TIncludes extends IncludeSpec<TContract, ModelName> = NoIncludes,
  TSelected extends string = never,
> {
  /**
   * Add a filter (ANDed with any previous `.where()` calls).
   *
   * Two forms:
   *
   * - **Shorthand**: `where({ field: value })` — multi-key shorthand
   *   objects compose as AND. `null` values become null-checks rather
   *   than literal-null equalities so absent fields match.
   * - **Callback**: `where((m) => m.field.op(value))` — receives the
   *   typed model accessor proxy and returns an `IdbFilterExpr` built
   *   via the operator surface. Combinators (`and`, `or`, `not` from
   *   `@prisma-idb/client-idb/orm`) compose nodes.
   */
  where(
    filter: WhereFilter<TContract, ModelName> | WhereCallback<TContract, ModelName>
  ): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected>;

  /** Set the sort order. Replaces any previous `.orderBy()` call. */
  orderBy(spec: OrderBySpec<TContract, ModelName>): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected>;

  /** Limit the number of rows returned. */
  take(n: number): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected>;

  /** Skip the first `n` rows (OFFSET). */
  skip(n: number): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected>;

  /**
   * Include a reference relation in the returned rows.
   *
   * The relation is loaded via a single batch cursor scan after the main
   * query — O(1) round trips to IDB per included relation regardless of
   * the number of parent rows. The return type gains the relation field
   * automatically.
   *
   * An optional refinement callback narrows the loaded relation:
   *
   * - return the (chained) collection to apply `where` / `orderBy` /
   *   `take` / `skip` to the related rows (per-parent for `1:N`);
   * - return `collection.count()` to reduce a to-many relation to the
   *   number of matching children (the field becomes a `number`).
   *
   * @example
   * ```ts
   * db.users.include("posts", (posts) => posts.where({ published: true }).take(5))
   * db.users.include("posts", (posts) => posts.count())
   * ```
   */
  include<K extends ReferenceRelKeys<TContract, ModelName>>(
    relation: K,
    refineFn?: IncludeRefineFn<
      TContract,
      ModelName,
      K,
      IdbIncludeRefinementAccessor<TContract, RelatedModelOf<TContract, ModelName, K>>
    >
  ): IdbStoreAccessor<TContract, ModelName, TIncludes & Record<K, true>, TSelected>;
  include<K extends ReferenceRelKeys<TContract, ModelName>>(
    relation: K,
    refineFn: IncludeRefineFn<TContract, ModelName, K, IdbIncludeScalar>
  ): IdbStoreAccessor<TContract, ModelName, TIncludes & Record<K, "scalar">, TSelected>;

  /**
   * Project the row down to a subset of scalar fields. Any previously
   * `.include()`d relations are preserved on the result; only the scalar
   * fields are narrowed.
   *
   * @example
   * ```ts
   * const summaries = await db.users.select("id", "email").all();
   * // typeof summaries[number] === { id: string; email: string }
   * ```
   */
  select<Fields extends FieldTuple<TContract, ModelName>>(
    ...fields: Fields
  ): IdbStoreAccessor<TContract, ModelName, TIncludes, Fields[number]>;

  /** Return all matching rows as an async iterable (also awaitable as `Row[]`). */
  all(): AsyncIterableResult<SelectedRow<TContract, ModelName, TIncludes, TSelected>>;

  /** Return the first matching row, or `null` if none match. */
  first(): Promise<SelectedRow<TContract, ModelName, TIncludes, TSelected> | null>;

  /**
   * Run an in-memory aggregate (count/sum/avg/min/max) over the rows matching
   * the accumulated `.where()` filter. Returns one result object keyed by the
   * aliases supplied in the spec.
   *
   * @example
   * ```ts
   * const stats = await db.posts.where({ published: true }).aggregate((agg) => ({
   *   total: agg.count(),
   *   avgViews: agg.avg("views"),
   * }));
   * ```
   */
  aggregate<Spec extends IdbAggregateSpec>(
    fn: (agg: IdbAggregateBuilder<TContract, ModelName>) => Spec
  ): Promise<IdbAggregateResult<Spec>>;

  /**
   * Switch to grouped-aggregate mode. The returned {@link IdbGroupedAccessor}'s
   * `.aggregate(...)` terminal produces one row per group with the chosen key
   * fields plus the requested aggregates.
   *
   * @example
   * ```ts
   * const byUser = await db.posts
   *   .where({ published: true })
   *   .groupBy("authorId")
   *   .aggregate((agg) => ({ count: agg.count(), totalViews: agg.sum("views") }));
   * ```
   */
  groupBy<Fields extends FieldTuple<TContract, ModelName>>(
    ...fields: Fields
  ): IdbGroupedAccessor<TContract, ModelName, Fields>;

  /**
   * Insert a record into the store and return the stored row.
   *
   * The primary key field is optional in `data` — pass it to use a
   * client-generated ID (`cuid`, `uuid`) or omit it for auto-increment stores.
   *
   * Relation fields accept a mutation callback:
   * `posts: (rel) => rel.create([...])` or `author: (rel) => rel.connect({ id })`.
   * When any relation callback is present, all writes are wrapped in a single
   * multi-store IDB transaction (requires IdbRuntime, not a plain executor).
   */
  create(data: MutationCreateInput<TContract, ModelName>): Promise<DefaultModelRow<TContract, ModelName>>;

  /** Look up a single row by primary key. Returns `null` if not found. */
  findUnique(key: KeyType<TContract, ModelName>): Promise<DefaultModelRow<TContract, ModelName> | null>;

  /** Delete the row with the given primary key. */
  delete(key: KeyType<TContract, ModelName>): Promise<void>;

  /**
   * Update the first row matching the accumulated `.where()` filter.
   * Returns the merged row, or `null` if no row matches.
   *
   * Relation fields accept `connect` or `disconnect` callbacks. When any
   * relation callback is present, all writes run in a single multi-store
   * IDB transaction (requires IdbRuntime).
   */
  update(patch: MutationUpdateInput<TContract, ModelName>): Promise<DefaultModelRow<TContract, ModelName> | null>;

  /**
   * Update all rows matching the accumulated `.where()` filter and return
   * them as an `AsyncIterableResult` (also awaitable as `Row[]`).
   */
  updateAll(patch: PatchInput<TContract, ModelName>): AsyncIterableResult<DefaultModelRow<TContract, ModelName>>;

  /**
   * Update all rows matching the accumulated `.where()` filter.
   * Returns the count of updated rows.
   */
  updateCount(patch: PatchInput<TContract, ModelName>): Promise<number>;

  /**
   * Insert or update a single record.
   *
   * - If a row matching `where` exists: shallow-merge `update` onto it and
   *   return the merged row.
   * - If no matching row exists: insert `create` and return it.
   */
  upsert(args: {
    create: CreateInput<TContract, ModelName>;
    update: PatchInput<TContract, ModelName>;
    where: WhereFilter<TContract, ModelName>;
  }): Promise<DefaultModelRow<TContract, ModelName>>;

  /**
   * Insert multiple records in a single atomic transaction.
   * Returns all inserted rows as an `AsyncIterableResult`.
   */
  createAll(data: CreateInput<TContract, ModelName>[]): AsyncIterableResult<DefaultModelRow<TContract, ModelName>>;

  /**
   * Insert multiple records in a single atomic transaction.
   * Returns the count of inserted rows.
   */
  createCount(data: CreateInput<TContract, ModelName>[]): Promise<number>;

  /**
   * Delete all rows matching the accumulated `.where()` filter.
   * Returns the deleted rows as an `AsyncIterableResult`.
   */
  deleteAll(): AsyncIterableResult<DefaultModelRow<TContract, ModelName>>;

  /**
   * Delete all rows matching the accumulated `.where()` filter.
   * Returns the count of deleted rows.
   */
  deleteCount(): Promise<number>;

  /**
   * Count all rows matching the accumulated `.where()` filter.
   * With no filter, counts all rows in the store.
   *
   * **Note — `skip`/`take` are respected**: unlike Prisma's SQL `count()`,
   * which ignores pagination, this implementation reuses the same cursor-scan
   * plan as `all()`. That means `where(...).take(5).count()` returns at most 5,
   * not the total number of matching rows. Use `where(...).count()` without
   * `take`/`skip` when you need an unbounded total.
   */
  count(): Promise<number>;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Concrete immutable query builder.
 *
 * Internal details:
 * - All state is in `#state` (filters, orderBy, skip, take, includes, selectedFields).
 * - Builder methods clone via `#clone()` — O(1) copies since state is
 *   structurally shared.
 * - `all()` materialises the main rows first, then batch-loads each included
 *   relation, then applies any `.select()` projection before yielding.
 * - `#includeRefinementMode` flips `count()` from an async terminal to an
 *   {@link IdbIncludeScalar} marker so it can be used inside `include()`.
 */
export class IdbStoreAccessorImpl<
  TContract extends IdbContract,
  ModelName extends string,
  TIncludes extends IncludeSpec<TContract, ModelName> = NoIncludes,
  TSelected extends string = never,
> implements IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected> {
  readonly #contract: TContract;
  readonly #modelName: ModelName;
  readonly #executor: IdbQueryExecutor;
  readonly #storeName: string;
  readonly #state: IdbAccessorState;
  readonly #newGroupingKey: () => string;
  readonly #includeRefinementMode: boolean;

  constructor(
    contract: TContract,
    modelName: ModelName,
    executor: IdbQueryExecutor,
    state?: IdbAccessorState,
    newGroupingKey?: () => string,
    includeRefinementMode = false
  ) {
    this.#contract = contract;
    this.#modelName = modelName;
    this.#executor = executor;
    this.#storeName = getStoreName(contract, modelName);
    this.#state = state ?? emptyAccessorState();
    // Default: per-instance counter (single client; avoids module-level interleaving).
    let _key = 0;
    this.#newGroupingKey = newGroupingKey ?? (() => `idb-op-${++_key}`);
    this.#includeRefinementMode = includeRefinementMode;
  }

  // ── Builder methods ───────────────────────────────────────────────────────

  where(
    filter: WhereFilter<TContract, ModelName> | WhereCallback<TContract, ModelName>
  ): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected> {
    const expr =
      typeof filter === "function"
        ? filter(createModelAccessor<TContract, ModelName>())
        : shorthandToFilterExpr(filter as Record<string, unknown>);
    // An empty shorthand object (or one with only undefined values) lifts
    // to `undefined` — keep the existing filter list untouched so chained
    // `.where({})` calls don't produce noisy AND nodes.
    if (expr === undefined) return this.#clone({});
    return this.#clone({ filters: [...this.#state.filters, expr] });
  }

  orderBy(spec: OrderBySpec<TContract, ModelName>): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected> {
    return this.#clone({ orderBy: spec as Record<string, "asc" | "desc"> });
  }

  take(n: number): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected> {
    return this.#clone({ take: n });
  }

  skip(n: number): IdbStoreAccessor<TContract, ModelName, TIncludes, TSelected> {
    return this.#clone({ skip: n });
  }

  include<K extends ReferenceRelKeys<TContract, ModelName>>(
    relation: K,
    refineFn?: IncludeRefineFn<
      TContract,
      ModelName,
      K,
      IdbIncludeRefinementAccessor<TContract, RelatedModelOf<TContract, ModelName, K>>
    >
  ): IdbStoreAccessor<TContract, ModelName, TIncludes & Record<K, true>, TSelected>;
  include<K extends ReferenceRelKeys<TContract, ModelName>>(
    relation: K,
    refineFn: IncludeRefineFn<TContract, ModelName, K, IdbIncludeScalar>
  ): IdbStoreAccessor<TContract, ModelName, TIncludes & Record<K, "scalar">, TSelected>;
  include<K extends ReferenceRelKeys<TContract, ModelName>>(
    relation: K,
    refineFn?: IncludeRefineFn<
      TContract,
      ModelName,
      K,
      IdbIncludeRefinementAccessor<TContract, RelatedModelOf<TContract, ModelName, K>> | IdbIncludeScalar
    >
  ): IdbStoreAccessor<TContract, ModelName, IncludeSpec<TContract, ModelName>, TSelected> {
    const entry = this.#resolveIncludeEntry(relation, refineFn);
    const newState = mergeAccessorState(this.#state, {
      includes: { ...this.#state.includes, [relation]: entry },
    });
    // The new instance is identical at runtime; the narrowed TIncludes type is
    // only a compile-time distinction — so an `as unknown as` cast is safe.
    return new IdbStoreAccessorImpl(
      this.#contract,
      this.#modelName,
      this.#executor,
      newState,
      this.#newGroupingKey,
      this.#includeRefinementMode
    ) as unknown as IdbStoreAccessor<TContract, ModelName, IncludeSpec<TContract, ModelName>, TSelected>;
  }

  select<Fields extends FieldTuple<TContract, ModelName>>(
    ...fields: Fields
  ): IdbStoreAccessor<TContract, ModelName, TIncludes, Fields[number]> {
    // Runtime is identical; only TSelected narrows. Cast bridges the type-level
    // projection (the clone preserves TIncludes / contract / executor).
    return this.#clone({ selectedFields: fields as readonly string[] }) as unknown as IdbStoreAccessor<
      TContract,
      ModelName,
      TIncludes,
      Fields[number]
    >;
  }

  // ── Execution methods ─────────────────────────────────────────────────────

  all(): AsyncIterableResult<SelectedRow<TContract, ModelName, TIncludes, TSelected>> {
    const groupingKey = this.#newGroupingKey();
    // Capture the private fields needed inside the generator. Private names
    // must be accessed on `this`, so we bind the methods to keep them callable
    // without aliasing `this` (no-this-alias).
    const buildScanPlan = this.#buildScanPlan.bind(this);
    const executeOrRows = this.#executeOrRows.bind(this);
    const executorQuery = this.#executor.query.bind(this.#executor);
    const applyIncludes = this.#applyIncludes.bind(this);
    const projectRows = this.#projectRows.bind(this);
    const combined = this.#combinedFilterExpr();
    const fieldToIndexMap =
      typeof IDBKeyRange !== "undefined" ? buildFieldToIndexMap(this.#contract, this.#storeName) : undefined;
    const keyPath = getKeyPath(this.#contract, this.#modelName);
    const comparator = buildRowComparator(this.#state.orderBy);
    const skip = this.#state.skip;
    const take = this.#state.take;
    return new AsyncIterableResult(
      (async function* (): AsyncGenerator<SelectedRow<TContract, ModelName, TIncludes, TSelected>, void, unknown> {
        let rows: Record<string, unknown>[];

        // OR multi-scan path: union N index point-range scans, deduplicate,
        // re-apply orderBy (the union has no overall ordering), then apply
        // skip/take in-memory (pagination must happen after the union).
        const orHint = fieldToIndexMap !== undefined ? extractIndexOrHint(combined, fieldToIndexMap, keyPath) : null;
        if (orHint !== null) {
          rows = await executeOrRows(orHint, groupingKey, combined);
          if (comparator !== undefined) rows.sort(comparator);
          if (skip !== undefined) rows = rows.slice(skip);
          if (take !== undefined) rows = rows.slice(0, take);
        } else {
          // AND single-index path (or full scan — decided inside buildScanPlan).
          const scanPlan = buildScanPlan<Record<string, unknown>>(groupingKey, fieldToIndexMap);
          rows = [];
          for await (const row of executorQuery(scanPlan)) {
            rows.push(row);
          }
        }

        // Batch-load any included relations (uses full rows — FK fields intact).
        const withIncludes = await applyIncludes(rows, groupingKey);

        // Apply any `.select()` projection, then yield.
        for (const row of projectRows(withIncludes)) {
          yield row as SelectedRow<TContract, ModelName, TIncludes, TSelected>;
        }
      })()
    );
  }

  async first(): Promise<SelectedRow<TContract, ModelName, TIncludes, TSelected> | null> {
    return this.take(1).all().first();
  }

  async aggregate<Spec extends IdbAggregateSpec>(
    fn: (agg: IdbAggregateBuilder<TContract, ModelName>) => Spec
  ): Promise<IdbAggregateResult<Spec>> {
    const spec = fn(createAggregateBuilder<TContract, ModelName>());
    assertValidAggregateSpec(spec, "aggregate()");
    const combined = this.#combinedFilterExpr();
    const ast: IdbAggregateAst = {
      kind: "aggregate",
      modelName: this.#modelName,
      aggregates: toAggregateRequests(spec),
      ...(combined !== undefined ? { where: combined } : {}),
    };
    const groupingKey = this.#newGroupingKey();

    // When `count` is the ONLY selector no row value is ever read, so the
    // total can come from a native count. A mixed spec (count alongside
    // sum/avg/min/max) needs the rows regardless, so it materializes. Like
    // the materialized path, aggregate() ignores skip/take.
    if (Object.values(spec).every((selector) => selector.fn === "count")) {
      const scanPlan = this.#buildScanPlan<Record<string, unknown>>(groupingKey);
      const total = await this.#executeNativeCount(scanPlan, ast);
      if (total !== null) {
        const result: Record<string, number | null> = {};
        for (const alias of Object.keys(spec)) result[alias] = total;
        return result as IdbAggregateResult<Spec>;
      }
    }

    const rows = await this.#materialize(groupingKey, ast);
    return computeAggregateSpec(spec, rows) as IdbAggregateResult<Spec>;
  }

  groupBy<Fields extends FieldTuple<TContract, ModelName>>(
    ...fields: Fields
  ): IdbGroupedAccessor<TContract, ModelName, Fields> {
    const combined = this.#combinedFilterExpr();
    const materialize = (ast: IdbQueryAst): Promise<Record<string, unknown>[]> =>
      this.#materialize(this.#newGroupingKey(), ast);
    return createGroupedAccessor<TContract, ModelName, Fields>({
      modelName: this.#modelName,
      by: fields as readonly string[],
      where: combined,
      materialize,
    });
  }

  async create(data: MutationCreateInput<TContract, ModelName>): Promise<DefaultModelRow<TContract, ModelName>> {
    const record = data as Record<string, unknown>;

    if (hasNestedMutationCallbacks(this.#contract, this.#modelName, record)) {
      const row = await executeNestedCreateMutation({
        executor: requireTransactionExecutor(this.#executor),
        contract: this.#contract,
        modelName: this.#modelName,
        data: record,
      });
      return row as DefaultModelRow<TContract, ModelName>;
    }

    if (hasScalarFkFields(this.#contract, this.#modelName, record)) {
      const row = await executeScalarCreateWithFkValidation({
        executor: requireTransactionExecutor(this.#executor),
        contract: this.#contract,
        modelName: this.#modelName,
        data: record,
      });
      return row as DefaultModelRow<TContract, ModelName>;
    }

    const groupingKey = this.#newGroupingKey();
    const meta = this.#planMeta(groupingKey);
    const withDefaults = applyCreateDefaults(
      this.#contract.execution?.mutations.defaults,
      this.#storeName,
      record,
      createMutationDefaultsCache()
    );
    const ast: IdbCreateAst = { kind: "create", modelName: this.#modelName, data: withDefaults };
    const plan: IdbQueryPlan<Record<string, unknown>> = {
      meta,
      ast,
      idbPlan: { meta, kind: "add", storeName: this.#storeName, record: withDefaults },
    };
    // The IDB driver echoes the stored record back as the single result row.
    for await (const row of this.#executor.query(plan)) {
      return row as DefaultModelRow<TContract, ModelName>;
    }
    return withDefaults as DefaultModelRow<TContract, ModelName>;
  }

  async findUnique(key: KeyType<TContract, ModelName>): Promise<DefaultModelRow<TContract, ModelName> | null> {
    const groupingKey = this.#newGroupingKey();
    const meta = this.#planMeta(groupingKey);
    const ast: IdbFindUniqueAst = { kind: "findUnique", modelName: this.#modelName, key };
    const plan: IdbQueryPlan<Record<string, unknown>> = {
      meta,
      ast,
      idbPlan: { meta, kind: "key-get", storeName: this.#storeName, key: key as IDBValidKey },
    };
    for await (const row of this.#executor.query(plan)) {
      return row as DefaultModelRow<TContract, ModelName>;
    }
    return null;
  }

  async delete(key: KeyType<TContract, ModelName>): Promise<void> {
    if (hasEnforceableChildRelations(this.#contract, this.#modelName)) {
      await executeDeleteWithReferentialActions({
        executor: requireTransactionExecutor(this.#executor),
        contract: this.#contract,
        modelName: this.#modelName,
        key: key as IDBValidKey,
      });
      return;
    }
    const groupingKey = this.#newGroupingKey();
    const meta = this.#planMeta(groupingKey);
    const ast: IdbDeleteAst = { kind: "delete", modelName: this.#modelName, key };
    const plan: IdbQueryPlan<Record<string, unknown>> = {
      meta,
      ast,
      idbPlan: { meta, kind: "delete", storeName: this.#storeName, key: key as IDBValidKey },
    };
    // The driver echoes the deleted row, but this API returns void — drain
    // via toArray() just to execute the plan and discard the result.
    await this.#executor.query(plan).toArray();
  }

  async update(
    patch: MutationUpdateInput<TContract, ModelName>
  ): Promise<DefaultModelRow<TContract, ModelName> | null> {
    const patchRecord = patch as Record<string, unknown>;

    if (hasNestedMutationCallbacks(this.#contract, this.#modelName, patchRecord)) {
      const row = await executeNestedUpdateMutation({
        executor: requireTransactionExecutor(this.#executor),
        contract: this.#contract,
        modelName: this.#modelName,
        filters: this.#state.filters,
        data: patchRecord,
      });
      return row as DefaultModelRow<TContract, ModelName> | null;
    }

    // Always routes through the transaction scope, whether or not the patch
    // touches a scalar FK field — same reasoning as `updateAll()` below: the
    // matched row isn't known until the scan-write actually runs (`.where()`
    // filters on ANY field, not just the primary key), and only the
    // transaction-scope path lets the sync interceptor observe that REAL row
    // and key it correctly (`SyncInterceptingTransactionScope#maybeTrack`'s
    // `update`/`scan-write` cases), atomically with the write itself.
    //
    // The previous plan-level fallback here (for patches with no FK field)
    // tried to recover the key by statically inspecting the filter AST
    // instead — which only worked for the narrow case of an equality filter
    // directly on the primary key (`.where({ id })`). Any other filter
    // (`.where({ name: "..." })`, a range, an OR) left the key unresolved,
    // and the outbox event synced with a raw filter tree the server
    // couldn't apply — or, after an earlier fix, was rejected outright with
    // `Unsupported update: filter does not pin "id" by equality`. Routing
    // through the transaction scope unconditionally removes the whole
    // category: the row (and therefore its key) comes from what actually
    // matched, not from re-deriving it from the filter that found it.
    const row = await executeScalarUpdateWithFkValidation({
      executor: requireTransactionExecutor(this.#executor),
      contract: this.#contract,
      modelName: this.#modelName,
      filters: this.#state.filters,
      data: patchRecord,
    });
    return row as DefaultModelRow<TContract, ModelName> | null;
  }

  /**
   * Always routes through the transaction scope (`executeBulkUpdateWithFkValidation`),
   * unlike single-row `update()`'s plan-level fallback for the no-FK-field
   * case. A bulk scan-write's affected row set isn't knowable until it
   * actually runs — going through the transaction scope is what lets the
   * sync interceptor observe the real affected rows and write one outbox
   * event per row (see `SyncInterceptingTransactionScope#maybeTrack`'s
   * `scan-write` case), atomically with the write itself, instead of one
   * event for the whole batch with no way to recover which rows it covered.
   */
  updateAll(patch: PatchInput<TContract, ModelName>): AsyncIterableResult<DefaultModelRow<TContract, ModelName>> {
    const contract = this.#contract;
    const modelName = this.#modelName;
    const filters = this.#state.filters;
    const patchRecord = patch as Record<string, unknown>;
    const executor = requireTransactionExecutor(this.#executor);
    return new AsyncIterableResult(
      (async function* (): AsyncGenerator<DefaultModelRow<TContract, ModelName>, void, unknown> {
        const rows = await executeBulkUpdateWithFkValidation({
          executor,
          contract,
          modelName,
          filters,
          data: patchRecord,
        });
        for (const row of rows) yield row as DefaultModelRow<TContract, ModelName>;
      })()
    );
  }

  async updateCount(patch: PatchInput<TContract, ModelName>): Promise<number> {
    return (await this.updateAll(patch).toArray()).length;
  }

  async upsert(args: {
    create: CreateInput<TContract, ModelName>;
    update: PatchInput<TContract, ModelName>;
    where: WhereFilter<TContract, ModelName>;
  }): Promise<DefaultModelRow<TContract, ModelName>> {
    const keyPath = getKeyPath(this.#contract, this.#modelName);
    const whereExpr = shorthandToFilterExpr(args.where as Record<string, unknown>);
    const matches = (row: Record<string, unknown>): boolean =>
      whereExpr === undefined || evaluateFilter(whereExpr, row);
    const meta = this.#planMeta(this.#newGroupingKey());
    const createRecord = args.create as Record<string, unknown>;
    const patchRecord = args.update as Record<string, unknown>;
    const storeName = this.#storeName;
    const executionDefaults = this.#contract.execution?.mutations.defaults;

    // Runs the find-then-write in a single readwrite transaction so there is
    // no check-then-act race window — atomicity is needed both for that and
    // for `onUpdate` referential-action enforcement (a multi-store read +
    // write) on the update branch. Mirrors the vendor's single-statement
    // upsert.
    const exec = requireTransactionExecutor(this.#executor);
    // Defaults are applied here, before store-name collection, rather than
    // inside the transaction: `collectOnUpdateEnforcementStoreNames` only
    // sees fields present in the patch it's given, and an `onUpdate` mutation
    // default can add a field that wasn't in the caller's raw patch — if that
    // field also happens to be a relation's local field, collecting stores
    // from the raw patch would under-declare the transaction's store list.
    // Applying defaults first (a pure function of the patch + static contract
    // config, no row read needed) and reusing the same result throughout
    // keeps enforcement, store collection, and the actual write looking at
    // one consistent effective patch.
    const effectivePatch = applyUpdateDefaults(
      executionDefaults,
      storeName,
      patchRecord,
      createMutationDefaultsCache()
    );
    const { storeNames: onUpdateStoreNames } = collectOnUpdateEnforcementStoreNames(
      this.#contract,
      this.#modelName,
      effectivePatch
    );
    // Either branch may set foreign keys, and which one runs isn't known until
    // the row is looked up, so declare the parent stores both would read.
    const storeNames = [
      ...new Set([
        storeName,
        ...onUpdateStoreNames,
        ...collectScalarFkStoreNames(this.#contract, this.#modelName, createRecord),
        ...collectScalarFkStoreNames(this.#contract, this.#modelName, patchRecord),
      ]),
    ];
    return withMutationScope(exec, storeNames, async (scope) => {
      const found = await scope.execute({ meta, kind: "cursor-scan", storeName, filter: matches, take: 1 });
      const existing = found[0];
      if (existing === undefined) {
        await validateScalarFks(scope, this.#contract, this.#modelName, createRecord);
        const record = applyCreateDefaults(executionDefaults, storeName, createRecord, createMutationDefaultsCache());
        const rows = await scope.execute({ meta, kind: "add", storeName, record });
        return (rows[0] ?? record) as DefaultModelRow<TContract, ModelName>;
      }
      await validateScalarFks(scope, this.#contract, this.#modelName, patchRecord, existing);
      const key = extractKeyFromRow(existing, keyPath);
      await applyReferentialActionsForRowOnUpdate(scope, this.#contract, this.#modelName, existing, effectivePatch);
      const rows = await scope.execute({ meta, kind: "update", storeName, key, patch: effectivePatch });
      return (rows[0] ?? existing) as DefaultModelRow<TContract, ModelName>;
    });
  }

  createAll(data: CreateInput<TContract, ModelName>[]): AsyncIterableResult<DefaultModelRow<TContract, ModelName>> {
    const rowsData = data as Record<string, unknown>[];
    if (rowsData.some((row) => hasScalarFkFields(this.#contract, this.#modelName, row))) {
      const executor = requireTransactionExecutor(this.#executor);
      const contract = this.#contract;
      const modelName = this.#modelName;
      return new AsyncIterableResult(
        (async function* (): AsyncGenerator<DefaultModelRow<TContract, ModelName>, void, unknown> {
          const rows = await executeScalarCreateAllWithFkValidation({ executor, contract, modelName, data: rowsData });
          for (const row of rows) yield row as DefaultModelRow<TContract, ModelName>;
        })()
      );
    }
    const groupingKey = this.#newGroupingKey();
    const meta = this.#planMeta(groupingKey);
    // One shared cache for the whole batch — every row in a single createAll()
    // call gets the same generated `temporal.updatedAt()` timestamp, matching
    // SQL's 'query'-stability semantics for the same generator.
    const defaultsCache = createMutationDefaultsCache();
    const executionDefaults = this.#contract.execution?.mutations.defaults;
    const records = data.map((d) =>
      applyCreateDefaults(executionDefaults, this.#storeName, d as Record<string, unknown>, defaultsCache)
    );
    const ast: IdbCreateAllAst = { kind: "createAll", modelName: this.#modelName, data: records };
    const plan: IdbQueryPlan<Record<string, unknown>> = {
      meta,
      ast,
      idbPlan: {
        meta,
        kind: "batch",
        storeNames: [this.#storeName],
        ops: records.map((record) => ({ meta, kind: "add" as const, storeName: this.#storeName, record })),
      },
    };
    const executorQuery = this.#executor.query.bind(this.#executor);
    return new AsyncIterableResult(
      (async function* (): AsyncGenerator<DefaultModelRow<TContract, ModelName>, void, unknown> {
        for await (const row of executorQuery(plan)) {
          yield row as DefaultModelRow<TContract, ModelName>;
        }
      })()
    );
  }

  async createCount(data: CreateInput<TContract, ModelName>[]): Promise<number> {
    return (await this.createAll(data).toArray()).length;
  }

  /**
   * Always routes through the transaction scope (`executeDeleteAllWithReferentialActions`),
   * not just when there are enforceable child relations to cascade — that
   * function already handles the no-relations case correctly (an empty
   * relation list is a no-op loop), and going through it unconditionally is
   * what lets the sync interceptor's transaction-scope tracking write one
   * outbox event per actually-deleted row instead of one lump event for
   * the whole batch with no way to know which rows it covered. See
   * `updateAll()`'s doc comment for the same reasoning.
   */
  deleteAll(): AsyncIterableResult<DefaultModelRow<TContract, ModelName>> {
    const combined = this.#combinedFilterExpr();
    const filter = combined !== undefined ? (row: Record<string, unknown>) => evaluateFilter(combined, row) : undefined;
    const contract = this.#contract;
    const modelName = this.#modelName;
    const executor = requireTransactionExecutor(this.#executor);
    return new AsyncIterableResult(
      (async function* (): AsyncGenerator<DefaultModelRow<TContract, ModelName>, void, unknown> {
        const rows = await executeDeleteAllWithReferentialActions({
          executor,
          contract,
          modelName,
          ...(filter !== undefined ? { filter } : {}),
        });
        for (const row of rows) yield row as DefaultModelRow<TContract, ModelName>;
      })()
    );
  }

  async deleteCount(): Promise<number> {
    return (await this.deleteAll().toArray()).length;
  }

  count(): Promise<number> {
    if (this.#includeRefinementMode) {
      // Inside an include() refinement, count() is a scalar-include marker that
      // include() consumes synchronously — not the async terminal below. The
      // IdbIncludeRefinementAccessor type surfaces the IdbIncludeScalar return;
      // this cast bridges count()'s dual runtime role.
      return createIncludeScalar(this.#state) as unknown as Promise<number>;
    }
    return this.#countTerminal();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async #countTerminal(): Promise<number> {
    const groupingKey = this.#newGroupingKey();
    const combined = this.#combinedFilterExpr();
    const fieldToIndexMap =
      typeof IDBKeyRange !== "undefined" ? buildFieldToIndexMap(this.#contract, this.#storeName) : undefined;

    // OR multi-scan path: count the deduped+filtered union, applying
    // skip/take pagination so count() is consistent with the non-OR path.
    // Never native: a per-branch count() double-counts a row that matches two
    // branches, and deduplication needs the actual primary keys.
    if (fieldToIndexMap !== undefined) {
      const keyPath = getKeyPath(this.#contract, this.#modelName);
      const orHint = extractIndexOrHint(combined, fieldToIndexMap, keyPath);
      if (orHint !== null) {
        const rows = await this.#executeOrRows(orHint, groupingKey, combined);
        return clampCount(rows.length, this.#state.skip, this.#state.take);
      }
    }

    const scanPlan = this.#buildScanPlan<Record<string, unknown>>(groupingKey, fieldToIndexMap);
    // Middleware sees a `count` AST regardless of which physical plan runs.
    const scanAst = scanPlan.ast;
    const ast: IdbCountAst = {
      kind: "count",
      modelName: this.#modelName,
      ...(scanAst?.kind === "findMany" && scanAst.where !== undefined ? { where: scanAst.where } : {}),
    };

    // Native path: when the whole `where` is captured by a key range (or
    // there is none), ask IndexedDB to count directly — no row is
    // deserialized. skip/take are applied to the native (unpaginated) total.
    const nativeTotal = await this.#executeNativeCount(scanPlan, ast);
    if (nativeTotal !== null) return clampCount(nativeTotal, this.#state.skip, this.#state.take);

    // Fallback: a residual in-memory filter needs each row's value, so the
    // rows must be materialized and counted.
    const plan: IdbQueryPlan<Record<string, unknown>> = { ...scanPlan, ast };
    let n = 0;
    for await (const _ of this.#executor.query(plan)) {
      n++;
    }
    return n;
  }

  /**
   * Resolve an `include()` argument pair into an {@link IncludeEntry}: run the
   * optional refinement against a fresh refinement-mode child accessor, then
   * classify the result as a scalar count or a refined collection.
   */
  #resolveIncludeEntry(relation: string, refineFn: ((collection: never) => unknown) | undefined): IncludeEntry {
    if (refineFn === undefined) {
      return { kind: "collection", state: emptyAccessorState() };
    }

    const rel = getRelation(this.#contract, this.#modelName, relation);
    // v0.12.0: `relation.to` is a CrossReference `{ namespace, model }`.
    const relatedModelName = rel?.to.model ?? relation;
    const child = new IdbStoreAccessorImpl(
      this.#contract,
      relatedModelName,
      this.#executor,
      emptyAccessorState(),
      this.#newGroupingKey,
      /* includeRefinementMode */ true
    );

    const refined = (refineFn as (c: unknown) => unknown)(child);

    if (isIncludeScalar(refined)) {
      if (rel !== undefined && rel.cardinality !== "1:N") {
        throw new Error(`include('${relation}'): count() is only supported for to-many (1:N) relations`);
      }
      return { kind: "scalar", fn: refined.fn, state: refined.state };
    }

    // Cross-instance private access is allowed within the class body.
    if (refined instanceof IdbStoreAccessorImpl) {
      return { kind: "collection", state: refined.#state };
    }

    throw new Error(
      `include('${relation}') refinement must return the collection (for where/orderBy/take/skip) or a count() selector`
    );
  }

  /**
   * Runs `scanPlan` as a native `count` plan when its cardinality is fully
   * determined by a key range (no in-memory filter) — returning the
   * *unpaginated* total — or `null` when it can't (the caller then falls back
   * to materializing). `ast` is attached so middleware sees the caller's
   * intent (`count` / `aggregate`) regardless of the physical plan.
   */
  async #executeNativeCount(scanPlan: IdbQueryPlan<Record<string, unknown>>, ast: IdbQueryAst): Promise<number | null> {
    const body = scanPlan.idbPlan;
    if (body.kind !== "cursor-scan" || !isNativelyCountable(body)) return null;
    const nativePlan: IdbQueryPlan<Record<string, unknown>> = { ...scanPlan, ast, idbPlan: toCountPlan(body) };
    let total = 0;
    for await (const row of this.#executor.query(nativePlan)) {
      total = (row as unknown as { count: number }).count;
    }
    return total;
  }

  /**
   * Materialise all rows matching the accumulated filters with no pagination —
   * used by `aggregate()` / `groupBy()`. The supplied `ast` is attached to the
   * scan plan so middleware can observe the aggregate intent.
   */
  async #materialize(groupingKey: string, ast: IdbQueryAst): Promise<Record<string, unknown>[]> {
    const combined = this.#combinedFilterExpr();
    const filter = combined !== undefined ? (row: Record<string, unknown>) => evaluateFilter(combined, row) : undefined;
    const meta = this.#planMeta(groupingKey);
    const plan: IdbQueryPlan<Record<string, unknown>> = {
      meta,
      ast,
      idbPlan: {
        meta,
        kind: "cursor-scan",
        storeName: this.#storeName,
        ...(filter !== undefined ? { filter } : {}),
      },
    };
    const rows: Record<string, unknown>[] = [];
    for await (const row of this.#executor.query(plan)) {
      rows.push(row);
    }
    return rows;
  }

  #buildScanPlan<Row>(groupingKey: string, fieldToIndexMap?: Record<string, string>): IdbQueryPlan<Row> {
    const combined = this.#combinedFilterExpr();
    const comparator = buildRowComparator(this.#state.orderBy);
    const meta = this.#planMeta(groupingKey);
    const ast: IdbFindManyAst = {
      kind: "findMany",
      modelName: this.#modelName,
      ...(combined !== undefined ? { where: combined } : {}),
      ...(this.#state.orderBy !== undefined ? { orderBy: this.#state.orderBy as Record<string, "asc" | "desc"> } : {}),
      ...(this.#state.skip !== undefined ? { skip: this.#state.skip } : {}),
      ...(this.#state.take !== undefined ? { take: this.#state.take } : {}),
    };

    // Attempt to peel an indexed equality condition from the combined filter
    // and use a cursor-scan over the index with a point range. This avoids
    // a full store scan when IDBKeyRange is available (browser / fake-indexeddb).
    if (typeof IDBKeyRange !== "undefined") {
      const fieldToIndexName = fieldToIndexMap ?? buildFieldToIndexMap(this.#contract, this.#storeName);
      const keyPath = getKeyPath(this.#contract, this.#modelName);
      const hint = extractIndexEqualityHint(combined, fieldToIndexName, keyPath);
      if (hint !== null) {
        const { indexName, value, remainingFilter } = hint;
        const filter =
          remainingFilter !== undefined
            ? (row: Record<string, unknown>) => evaluateFilter(remainingFilter, row)
            : undefined;
        return {
          meta,
          ast,
          idbPlan: {
            meta,
            kind: "cursor-scan" as const,
            storeName: this.#storeName,
            ...(indexName !== undefined ? { indexName } : {}),
            range: IDBKeyRange.only(value as IDBValidKey),
            ...(filter !== undefined ? { filter } : {}),
            ...(comparator !== undefined ? { comparator } : {}),
            ...(this.#state.skip !== undefined ? { skip: this.#state.skip } : {}),
            ...(this.#state.take !== undefined ? { take: this.#state.take } : {}),
          },
        } as IdbQueryPlan<Row>;
      }
    }

    // Fallback: full cursor scan.
    const filter = combined !== undefined ? (row: Record<string, unknown>) => evaluateFilter(combined, row) : undefined;
    // exactOptionalPropertyTypes: spread conditionally to avoid `undefined`
    // values in optional fields.
    return {
      meta,
      ast,
      idbPlan: {
        meta,
        kind: "cursor-scan" as const,
        storeName: this.#storeName,
        ...(filter !== undefined ? { filter } : {}),
        ...(comparator !== undefined ? { comparator } : {}),
        ...(this.#state.skip !== undefined ? { skip: this.#state.skip } : {}),
        ...(this.#state.take !== undefined ? { take: this.#state.take } : {}),
      },
    } as IdbQueryPlan<Row>;
  }

  /**
   * Execute one cursor-scan per OR branch, union the results, deduplicate by
   * primary key, and apply `hint.remainingFilter` in-memory. Skip/take are
   * NOT applied here — the caller slices the array after union so pagination
   * is correct across branches.
   */
  async #executeOrRows(
    hint: IndexOrHint,
    groupingKey: string,
    combined: IdbFilterExpr | undefined
  ): Promise<Record<string, unknown>[]> {
    const meta = this.#planMeta(groupingKey);
    const storeName = this.#storeName;
    const keyPath = getKeyPath(this.#contract, this.#modelName);
    const seen = new Set<unknown>();
    const rows: Record<string, unknown>[] = [];
    const ast: IdbFindManyAst = {
      kind: "findMany",
      modelName: this.#modelName,
      ...(combined !== undefined ? { where: combined } : {}),
    };

    // Branches are independent index scans — run them concurrently, then
    // merge/dedupe sequentially (first-branch-wins) so results stay
    // deterministic regardless of completion order.
    const branchResults = await Promise.all(
      hint.branches.map(async (branch) => {
        const plan: IdbQueryPlan<Record<string, unknown>> = {
          meta,
          ast,
          idbPlan: {
            meta,
            kind: "cursor-scan" as const,
            storeName,
            ...(branch.indexName !== undefined ? { indexName: branch.indexName } : {}),
            range: IDBKeyRange.only(branch.value as IDBValidKey),
          },
        };
        const branchRows: Record<string, unknown>[] = [];
        for await (const row of this.#executor.query(plan)) {
          branchRows.push(row);
        }
        return branchRows;
      })
    );
    for (const branchRows of branchResults) {
      for (const row of branchRows) {
        const pk = keyToken(extractKeyFromRow(row, keyPath));
        if (!seen.has(pk)) {
          seen.add(pk);
          rows.push(row);
        }
      }
    }

    if (hint.remainingFilter === undefined) return rows;
    const { remainingFilter } = hint;
    return rows.filter((row) => evaluateFilter(remainingFilter, row));
  }

  /**
   * Combine all accumulated filter expressions with AND.
   *
   * Returns `undefined` when no filter has been installed so the driver can
   * skip building a row filter closure (a small perf and readability win on
   * `.all()` paths). Delegates to the shared {@link combineFilterExprs}.
   */
  #combinedFilterExpr(): IdbFilterExpr | undefined {
    return combineFilterExprs(this.#state.filters);
  }

  async #applyIncludes(rows: Record<string, unknown>[], groupingKey: string): Promise<Record<string, unknown>[]> {
    const relNames = Object.keys(this.#state.includes);
    if (relNames.length === 0) return rows;
    let result = rows;
    for (const relName of relNames) {
      const entry = this.#state.includes[relName]!;
      result = await loadRelation(relName, entry, result, this.#contract, this.#modelName, this.#executor, groupingKey);
    }
    return result;
  }

  /**
   * Apply a `.select()` projection (if any) to materialised rows. Keeps the
   * selected scalar fields plus every included relation key (which `include()`
   * attached during {@link #applyIncludes}); a no-op when nothing is selected.
   */
  #projectRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const selected = this.#state.selectedFields;
    if (selected === undefined) return rows;
    const keep = [...selected, ...Object.keys(this.#state.includes)];
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const field of keep) {
        if (field in row) out[field] = row[field];
      }
      return out;
    });
  }

  #planMeta(groupingKey: string): PlanMeta {
    return {
      target: "idb",
      storageHash: this.#contract.storage.storageHash,
      lane: "idb-orm",
      annotations: { groupingKey },
    };
  }

  #clone(overrides: Partial<IdbAccessorState>): IdbStoreAccessorImpl<TContract, ModelName, TIncludes, TSelected> {
    return new IdbStoreAccessorImpl(
      this.#contract,
      this.#modelName,
      this.#executor,
      mergeAccessorState(this.#state, overrides),
      this.#newGroupingKey,
      this.#includeRefinementMode
    );
  }
}
