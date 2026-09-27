/**
 * Pure-JS evaluator for {@link IdbFilterExpr}.
 *
 * The driver's `IdbRowFilter` type stays as `(row) => boolean` — the
 * accessor builds a closure that calls `evaluateFilter(expr, row)` and
 * passes that to the driver. The driver therefore never imports the
 * adapter's AST types, and keeps no dependency on the adapter.
 *
 * Equality and ordering compare values the way IndexedDB compares keys, so
 * a filter gives the same answer whether it runs here or through an index
 * key range. Plain `===` would never match two equal `Date`s or byte arrays,
 * because values read back from IndexedDB are fresh objects. String
 * operations coerce both sides via `String(...)` so they work on numbers too.
 */

import { compareFieldValues, fieldValuesEqual } from "@prisma-idb/target-idb/runtime";
import type { IdbFilterExpr } from "./idb-filter-expr";

/** Evaluate an AST node against a single row. Returns `true` to keep the row. */
export function evaluateFilter(expr: IdbFilterExpr, row: Record<string, unknown>): boolean {
  switch (expr.kind) {
    case "field":
      return evalFieldOp(expr.field, expr.op, expr.value, row);
    case "and": {
      for (const e of expr.exprs) {
        if (!evaluateFilter(e, row)) return false;
      }
      return true;
    }
    case "or": {
      if (expr.exprs.length === 0) return false;
      for (const e of expr.exprs) {
        if (evaluateFilter(e, row)) return true;
      }
      return false;
    }
    case "not":
      return !evaluateFilter(expr.expr, row);
    case "null-check": {
      const v = row[expr.field];
      const isNullish = v === null || v === undefined;
      return expr.isNull ? isNullish : !isNullish;
    }
  }
}

function evalFieldOp(field: string, op: string, value: unknown, row: Record<string, unknown>): boolean {
  const cell = row[field];
  switch (op) {
    case "eq":
      // `eq` treats null and undefined as equivalent so the shorthand path
      // (`{ field: someValue }`) keeps working when stored rows omit the
      // field. Literal-null equality goes through `null-check` instead.
      if (value === null) return cell === null || cell === undefined;
      return fieldValuesEqual(cell, value);
    case "neq":
      if (value === null) return cell !== null && cell !== undefined;
      return !fieldValuesEqual(cell, value);
    case "gt":
      return isPresent(cell) && isPresent(value) && compareFieldValues(cell, value) > 0;
    case "lt":
      return isPresent(cell) && isPresent(value) && compareFieldValues(cell, value) < 0;
    case "gte":
      return isPresent(cell) && isPresent(value) && compareFieldValues(cell, value) >= 0;
    case "lte":
      return isPresent(cell) && isPresent(value) && compareFieldValues(cell, value) <= 0;
    case "in": {
      if (!Array.isArray(value)) return false;
      return value.some((v) => fieldValuesEqual(cell, v));
    }
    case "notIn": {
      if (!Array.isArray(value)) return true;
      return !value.some((v) => fieldValuesEqual(cell, v));
    }
    case "contains":
      return cell !== undefined && cell !== null && String(cell).includes(String(value));
    case "startsWith":
      return cell !== undefined && cell !== null && String(cell).startsWith(String(value));
    case "endsWith":
      return cell !== undefined && cell !== null && String(cell).endsWith(String(value));
    default:
      return false;
  }
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}
