import type { CatalogField } from "./planner/catalog";
import type { AggregateFn, IdbAggregateBuilder, IdbAggregateSelector } from "./types";

/**
 * Build the aggregate selector factory handed to `.aggregate(agg => …)` and
 * `groupBy(...).aggregate(agg => …)`.
 *
 * Each method returns an {@link IdbAggregateSelector} marker; the actual
 * reduction happens in {@link reduceAggregate} once the matching rows are
 * materialised in memory. Mirrors `createAggregateBuilder` from the vendor
 * `sql-orm-client/aggregate-builder.ts`, minus the field→column mapping (IDB
 * stores native field names).
 */
export function createAggregateBuilder<TContract, ModelName extends string>(): IdbAggregateBuilder<
  TContract,
  ModelName
> {
  return {
    count: () => ({ kind: "aggregate", fn: "count" }),
    sum: (field) => ({ kind: "aggregate", fn: "sum", field: field as string }),
    avg: (field) => ({ kind: "aggregate", fn: "avg", field: field as string }),
    min: (field) => ({ kind: "aggregate", fn: "min", field: field as string }),
    max: (field) => ({ kind: "aggregate", fn: "max", field: field as string }),
  };
}

/** Type guard: is `value` an {@link IdbAggregateSelector}? */
function isAggregateSelector(value: unknown): value is IdbAggregateSelector<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; fn?: unknown };
  return (
    candidate.kind === "aggregate" &&
    (candidate.fn === "count" ||
      candidate.fn === "sum" ||
      candidate.fn === "avg" ||
      candidate.fn === "min" ||
      candidate.fn === "max")
  );
}

/**
 * Reduce a set of materialised rows to a single aggregate value.
 *
 * - `count` → the number of rows (always a number, never null).
 * - `sum`/`avg`/`min`/`max` → computed over the non-null numeric values of
 *   `field`; `null` when no row has a non-null value (matching Prisma's
 *   "aggregate of an empty set is null" and the vendor `coerceAggregateValue`
 *   null handling). Values must match the declared number codec.
 */
function reduceAggregate(
  fn: AggregateFn,
  field: string | undefined,
  rows: readonly Record<string, unknown>[],
  codecId: string | undefined
): number | null {
  if (fn === "count") return rows.length;
  if (field === undefined) return null;

  const values: number[] = [];
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new TypeError(`${fn}("${field}") requires finite number values`);
    }
    if (codecId === "idb/int32@1" && (!Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647)) {
      throw new TypeError(`${fn}("${field}") requires Int values in the signed 32-bit range`);
    }
    values.push(raw);
  }

  if (values.length === 0) return null;

  switch (fn) {
    case "sum":
      return sumValues(values, field, codecId === "idb/int32@1");
    case "avg":
      return sumValues(values, field, codecId === "idb/int32@1") / values.length;
    // Not `Math.min(...values)`: spreading a large array overflows the call stack.
    case "min":
      return values.reduce((acc, n) => Math.min(acc, n));
    case "max":
      return values.reduce((acc, n) => Math.max(acc, n));
  }
}

/** Reject overflow before a rounded or nonfinite intermediate total can reach the result. */
function sumValues(values: readonly number[], field: string, integer: boolean): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isFinite(total) || (integer && !Number.isSafeInteger(total))) {
      throw new RangeError(
        `Aggregate total for "${field}" exceeds the ${integer ? "safe integer" : "finite number"} range`
      );
    }
  }
  return total;
}

/**
 * Run every selector in an aggregate spec against `rows`, producing the
 * result object keyed by the spec's aliases.
 */
export function computeAggregateSpec(
  spec: Record<string, IdbAggregateSelector<unknown>>,
  rows: readonly Record<string, unknown>[],
  fields: Readonly<Record<string, CatalogField>> = {}
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [alias, selector] of Object.entries(spec)) {
    result[alias] = reduceAggregate(selector.fn, selector.field, rows, fields[selector.field ?? ""]?.codecId);
  }
  return result;
}

/**
 * Project an aggregate spec down to the plain `{ fn, field? }` shape carried by
 * the query AST (`IdbAggregateAst.aggregates` / `IdbGroupByAst.aggregates`), so
 * middleware can observe the requested aggregations.
 */
export function toAggregateRequests(
  spec: Record<string, IdbAggregateSelector<unknown>>
): Record<string, { readonly fn: string; readonly field?: string }> {
  const out: Record<string, { fn: string; field?: string }> = {};
  for (const [alias, selector] of Object.entries(spec)) {
    out[alias] = selector.field !== undefined ? { fn: selector.fn, field: selector.field } : { fn: selector.fn };
  }
  return out;
}

/**
 * Validate a user-supplied aggregate spec: it must be non-empty and every
 * value must be a real selector over a declared scalar number field (except
 * count, which has no field). Throws a descriptive error otherwise, so a
 * typo (e.g. returning a plain object) fails loudly rather than silently
 * producing `NaN`/`undefined` results.
 */
export function assertValidAggregateSpec(
  spec: Record<string, unknown>,
  context: "aggregate()" | "groupBy().aggregate()",
  fields: Readonly<Record<string, CatalogField>>
): void {
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new Error(`${context} requires at least one aggregation selector`);
  }
  for (const [alias, selector] of entries) {
    if (!isAggregateSelector(selector)) {
      throw new Error(`${context} selector "${alias}" is invalid`);
    }
    if (selector.fn === "count") continue;
    const field = typeof selector.field === "string" ? fields[selector.field] : undefined;
    if (!field || field.collection || (field.codecId !== "idb/int32@1" && field.codecId !== "idb/double@1")) {
      throw new TypeError(`${context} selector "${alias}" requires a declared number field (Int or Float)`);
    }
  }
}
