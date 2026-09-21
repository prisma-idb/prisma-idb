import type { AggregateFn, IdbAggregateBuilder, IdbAggregateSelector } from "./types";

/**
 * Build the aggregate selector factory handed to `.aggregate(agg => …)` and
 * `groupBy(...).aggregate(agg => …)`.
 *
 * Each method returns a frozen {@link IdbAggregateSelector} marker; the actual
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
export function isAggregateSelector(value: unknown): value is IdbAggregateSelector<unknown> {
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
 *   null handling). String-encoded numbers are coerced via `Number()`.
 */
export function reduceAggregate(
  fn: AggregateFn,
  field: string | undefined,
  rows: readonly Record<string, unknown>[]
): number | null {
  if (fn === "count") return rows.length;
  if (field === undefined) return null;

  const values: number[] = [];
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === "bigint" ? Number(raw) : Number(raw as number);
    if (!Number.isNaN(n)) values.push(n);
  }

  if (values.length === 0) return null;

  switch (fn) {
    case "sum":
      return values.reduce((acc, n) => acc + n, 0);
    case "avg":
      return values.reduce((acc, n) => acc + n, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

/**
 * Run every selector in an aggregate spec against `rows`, producing the
 * result object keyed by the spec's aliases.
 */
export function computeAggregateSpec(
  spec: Record<string, IdbAggregateSelector<unknown>>,
  rows: readonly Record<string, unknown>[]
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [alias, selector] of Object.entries(spec)) {
    result[alias] = reduceAggregate(selector.fn, selector.field, rows);
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
 * value must be a real selector. Throws a descriptive error otherwise, so a
 * typo (e.g. returning a plain object) fails loudly rather than silently
 * producing `NaN`/`undefined` results.
 */
export function assertValidAggregateSpec(
  spec: Record<string, unknown>,
  context: "aggregate()" | "groupBy().aggregate()"
): void {
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new Error(`${context} requires at least one aggregation selector`);
  }
  for (const [alias, selector] of entries) {
    if (!isAggregateSelector(selector)) {
      throw new Error(`${context} selector "${alias}" is invalid`);
    }
  }
}
