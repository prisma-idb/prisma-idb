/**
 * Pure-JS evaluator for {@link IdbFilterExpr}.
 *
 * The driver's `IdbRowFilter` type stays as `(row) => boolean` — the
 * accessor builds a closure that calls `evaluateFilter(expr, row)` and
 * passes that to the driver. The driver therefore never imports the
 * adapter's AST types, and keeps no dependency on the adapter.
 *
 * Decimal metadata selects exact numeric comparison. Other fields compare
 * values the way IndexedDB compares keys, so a filter agrees with an index
 * key range. Plain `===` would never match two equal `Date`s or byte arrays,
 * because values read back from IndexedDB are fresh objects. String
 * operations coerce both sides via `String(...)` so they work on numbers too.
 */

import {
  compareDecimalValues,
  compareFieldValues,
  fieldValuesEqual,
  isDecimalString,
} from "@prisma-idb/target-idb/runtime";
import type { IdbFilterExpr, IdbFilterOp } from "./idb-filter-expr";

/** Codec metadata determines which string fields have numeric Decimal semantics. */
export type FilterFieldMetadata = Readonly<
  Record<string, { readonly codecId?: string | undefined; readonly collection?: boolean }>
>;

/** Reject invalid Decimal operands even when no stored row reaches the evaluator. */
export function assertValidDecimalFilter(expr: IdbFilterExpr, fields: FilterFieldMetadata): void {
  if (expr.kind === "and" || expr.kind === "or") {
    expr.exprs.forEach((child) => assertValidDecimalFilter(child, fields));
  } else if (expr.kind === "not") {
    assertValidDecimalFilter(expr.expr, fields);
  } else if (expr.kind === "field" && isDecimalField(fields, expr.field)) {
    // Text operators inspect the stored spelling and need no numeric operand.
    if (expr.op === "contains" || expr.op === "startsWith" || expr.op === "endsWith") return;
    const values = expr.op === "in" || expr.op === "notIn" ? expr.value : [expr.value];
    if (Array.isArray(values) && values.some((value) => isPresent(value) && !isDecimalString(value))) {
      throw new TypeError(`Expected finite Decimal text for field "${expr.field}"`);
    }
  }
}

/** Identify scalar Decimal fields without reinterpreting string or collection values. */
function isDecimalField(fields: FilterFieldMetadata, field: string): boolean {
  return fields[field]?.codecId === "idb/decimal@1" && !fields[field]?.collection;
}

/** Evaluate an AST node against a single row. Returns `true` to keep the row. */
export function evaluateFilter(
  expr: IdbFilterExpr,
  row: Record<string, unknown>,
  fields: FilterFieldMetadata = {}
): boolean {
  switch (expr.kind) {
    case "field":
      return evalFieldOp(expr.field, expr.op, expr.value, row, fields);
    case "and": {
      for (const e of expr.exprs) {
        if (!evaluateFilter(e, row, fields)) return false;
      }
      return true;
    }
    case "or": {
      for (const e of expr.exprs) {
        if (evaluateFilter(e, row, fields)) return true;
      }
      return false;
    }
    case "not":
      return !evaluateFilter(expr.expr, row, fields);
    case "null-check": {
      const v = row[expr.field];
      const isNullish = v === null || v === undefined;
      return expr.isNull ? isNullish : !isNullish;
    }
  }
}

/** Evaluate one field predicate with the same comparisons used by index-backed queries. */
function evalFieldOp(
  field: string,
  op: IdbFilterOp,
  value: unknown,
  row: Record<string, unknown>,
  fields: FilterFieldMetadata
): boolean {
  const cell = row[field];
  const decimal = isDecimalField(fields, field);
  const compare = decimal ? compareDecimalValues : compareFieldValues;
  const equal = decimal
    ? (a: unknown, b: unknown) =>
        isPresent(a) && isPresent(b) ? compareDecimalValues(a, b) === 0 : fieldValuesEqual(a, b)
    : fieldValuesEqual;
  switch (op) {
    case "eq":
      // `eq` treats null and undefined as equivalent so the shorthand path
      // (`{ field: someValue }`) keeps working when stored rows omit the
      // field. Literal-null equality goes through `null-check` instead.
      if (value === null) return cell === null || cell === undefined;
      return equal(cell, value);
    case "neq":
      if (value === null) return cell !== null && cell !== undefined;
      return !equal(cell, value);
    case "gt":
      return isPresent(cell) && isPresent(value) && compare(cell, value) > 0;
    case "lt":
      return isPresent(cell) && isPresent(value) && compare(cell, value) < 0;
    case "gte":
      return isPresent(cell) && isPresent(value) && compare(cell, value) >= 0;
    case "lte":
      return isPresent(cell) && isPresent(value) && compare(cell, value) <= 0;
    case "in": {
      if (!Array.isArray(value)) return false;
      return value.some((v) => equal(cell, v));
    }
    case "notIn": {
      if (!Array.isArray(value)) return true;
      return !value.some((v) => equal(cell, v));
    }
    case "contains":
      return isPresent(cell) && String(cell).includes(String(value));
    case "startsWith":
      return isPresent(cell) && String(cell).startsWith(String(value));
    case "endsWith":
      return isPresent(cell) && String(cell).endsWith(String(value));
    default:
      return false;
  }
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}
