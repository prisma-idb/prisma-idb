/**
 * Proxy-based typed accessor handed to `where(fn)` callbacks.
 *
 * Mirrors `createModelAccessor()` from
 * Prisma ORM's SQL client, but without
 * the codec-trait gating — IDB stores native JS values, so every operator
 * is available on every field. The runtime accessor object is a Proxy
 * that materialises an `IdbFieldAccessor` on demand for whichever field
 * name is read; the type-level surface narrows that to the model's
 * actual field set so callbacks get autocomplete.
 */

import {
  type IdbFieldFilter,
  type IdbFilterExpr,
  type IdbNullCheckExpr,
  fieldFilter,
  nullCheckExpr,
} from "@prisma-idb/adapter-idb/runtime";
import type { DefaultModelRow, IdbContract } from "./types";

// ── Typed surface ─────────────────────────────────────────────────────────────

/**
 * Operator surface available on every field. All return frozen AST nodes
 * — they are values, not statements, so chaining and logical combinators
 * compose naturally.
 */
export interface IdbFieldAccessor<T> {
  eq(value: T): IdbFieldFilter;
  neq(value: T): IdbFieldFilter;
  gt(value: T): IdbFieldFilter;
  lt(value: T): IdbFieldFilter;
  gte(value: T): IdbFieldFilter;
  lte(value: T): IdbFieldFilter;
  in(values: ReadonlyArray<T>): IdbFieldFilter;
  notIn(values: ReadonlyArray<T>): IdbFieldFilter;
  contains(sub: string): IdbFieldFilter;
  startsWith(sub: string): IdbFieldFilter;
  endsWith(sub: string): IdbFieldFilter;
  isNull(): IdbNullCheckExpr;
  isNotNull(): IdbNullCheckExpr;
}

/**
 * The accessor object handed to a `where(fn)` callback. Each key resolves
 * to an {@link IdbFieldAccessor} typed against the field's output type.
 *
 * The Proxy makes every string key resolve to an accessor at runtime; the
 * type narrows the visible surface to the model's declared fields so the
 * developer gets autocomplete.
 */
export type IdbModelAccessor<TContract, ModelName extends string> = {
  readonly [K in keyof DefaultModelRow<TContract, ModelName>]-?: IdbFieldAccessor<
    DefaultModelRow<TContract, ModelName>[K]
  >;
};

// ── Runtime construction ──────────────────────────────────────────────────────

/**
 * Build an {@link IdbFieldAccessor} for a single field. The accessor is
 * shared via the proxy below, but each accessor instance is bound to its
 * own field name so the produced AST nodes carry the right field.
 */
function createFieldAccessor(field: string): IdbFieldAccessor<unknown> {
  return {
    eq: (value) => fieldFilter(field, "eq", value),
    neq: (value) => fieldFilter(field, "neq", value),
    gt: (value) => fieldFilter(field, "gt", value),
    lt: (value) => fieldFilter(field, "lt", value),
    gte: (value) => fieldFilter(field, "gte", value),
    lte: (value) => fieldFilter(field, "lte", value),
    in: (values) => fieldFilter(field, "in", values),
    notIn: (values) => fieldFilter(field, "notIn", values),
    contains: (sub) => fieldFilter(field, "contains", sub),
    startsWith: (sub) => fieldFilter(field, "startsWith", sub),
    endsWith: (sub) => fieldFilter(field, "endsWith", sub),
    isNull: () => nullCheckExpr(field, true),
    isNotNull: () => nullCheckExpr(field, false),
  };
}

/**
 * Create the typed model accessor used by `where(fn)` callbacks.
 *
 * Implemented as a Proxy keyed on field names — every read returns an
 * {@link IdbFieldAccessor} bound to that field. The accessor cache means
 * `m.name.eq(...)` and `m.name.startsWith(...)` reuse the same per-field
 * accessor object across the same `where()` invocation.
 *
 * The type parameter is structural — no contract is consulted at
 * runtime, because TS already gates the visible field set at compile
 * time. (Misspelled fields surface as accessor calls on names that
 * don't exist in stored rows, which is consistent with how the
 * shorthand form behaves today.)
 */
export function createModelAccessor<TContract extends IdbContract, ModelName extends string>(): IdbModelAccessor<
  TContract,
  ModelName
> {
  const cache = new Map<string, IdbFieldAccessor<unknown>>();
  return new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop !== "string") return undefined;
        let acc = cache.get(prop);
        if (acc === undefined) {
          acc = createFieldAccessor(prop);
          cache.set(prop, acc);
        }
        return acc;
      },
    }
  ) as IdbModelAccessor<TContract, ModelName>;
}

// ── Re-export the AST type the callback returns ───────────────────────────────

export type { IdbFilterExpr };
