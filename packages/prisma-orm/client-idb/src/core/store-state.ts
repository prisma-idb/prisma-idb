import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";

/**
 * One entry in {@link IdbAccessorState.includes} — describes how a single
 * `.include()`d relation should be materialised.
 *
 * - `collection`: load the related rows, applying the refined `state`
 *   (its `filters` / `orderBy` / `skip` / `take`) to the child scan.
 *   `state` is `emptyAccessorState()` for an unrefined `.include(rel)`.
 * - `scalar`: reduce the related rows to a single number (Phase 6.5 supports
 *   `count`). The `state.filters` still constrain which children are counted.
 *
 * Mirrors the `IncludeExpr` / `IncludeScalar` split from
 * Prisma ORM's SQL client, collapsed to the two shapes IDB
 * needs (no SQL column mapping, no `combine()` branches).
 */
export type IncludeEntry =
  | { readonly kind: "collection"; readonly state: IdbAccessorState }
  | { readonly kind: "scalar"; readonly fn: "count"; readonly state: IdbAccessorState };

/**
 * Marker returned by the child accessor's `.count()` terminal when it is
 * called inside an `include()` refinement callback. Carries the refined
 * child `state` so the relation loader counts only the matching children.
 *
 * Detected by {@link isIncludeScalar}; mirrors `IncludeScalar` from the
 * vendor `sql-orm-client/include-descriptors.ts`.
 */
export interface IdbIncludeScalar {
  readonly kind: "includeScalar";
  readonly fn: "count";
  readonly state: IdbAccessorState;
}

/** Build an {@link IdbIncludeScalar} marker for a `count()` reducer. */
export function createIncludeScalar(state: IdbAccessorState): IdbIncludeScalar {
  return { kind: "includeScalar", fn: "count", state };
}

/** Type guard: is `value` an {@link IdbIncludeScalar} marker? */
export function isIncludeScalar(value: unknown): value is IdbIncludeScalar {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; fn?: unknown };
  return candidate.kind === "includeScalar" && candidate.fn === "count";
}

/**
 * Immutable state carried by each {@link IdbStoreAccessorImpl} node in the
 * builder chain.
 *
 * Every mutating method (`.where()`, `.take()`, etc.) returns a cloned
 * instance with an updated state rather than mutating in place, making the
 * accessor safe to reuse across multiple query branches.
 */
export interface IdbAccessorState {
  /**
   * Accumulated filter expressions. Multiple `.where()` calls compose
   * with AND semantics — the planner wraps them in an `andExpr` when
   * lowering. Each entry is already either an `IdbFieldFilter`, a
   * combinator, or a `null-check` node — never raw shorthand records.
   */
  readonly filters: ReadonlyArray<IdbFilterExpr>;
  /** Sort spec: field → direction. Applied as an in-memory comparator. */
  readonly orderBy?: Record<string, "asc" | "desc">;
  /** OFFSET (number of rows to skip). */
  readonly skip?: number;
  /** LIMIT (maximum number of rows to return). */
  readonly take?: number;
  /**
   * Relations that have been `.include()`d — keys are relation names, values
   * describe how to materialise each (collection vs scalar count, plus any
   * refinement state). See {@link IncludeEntry}.
   */
  readonly includes: Record<string, IncludeEntry>;
  /**
   * Fields kept by `.select()`. `undefined` means "all fields". When set,
   * the materialised rows are projected down to these fields (plus any
   * included relation keys) after the scan and relation loads complete.
   */
  readonly selectedFields?: ReadonlyArray<string>;
}

/** Create a fresh, empty accessor state (no filters, no ordering, no includes). */
export function emptyAccessorState(): IdbAccessorState {
  return {
    filters: [],
    includes: {},
  };
}

/** Return a shallow-merged copy of `state` with the given overrides applied. */
export function mergeAccessorState(state: IdbAccessorState, overrides: Partial<IdbAccessorState>): IdbAccessorState {
  return { ...state, ...overrides };
}
