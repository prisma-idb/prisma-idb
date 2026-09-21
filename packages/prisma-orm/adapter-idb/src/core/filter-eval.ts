/**
 * Pure-JS evaluator for {@link IdbFilterExpr}.
 *
 * The driver's `IdbRowFilter` type stays as `(row) => boolean` — the
 * accessor builds a closure that calls `evaluateFilter(expr, row)` and
 * passes that to the driver. The driver therefore never imports the
 * adapter's AST types, preserving the layering rule in ARCHITECTURE.md.
 *
 * Comparisons use JS semantics (numeric vs string ordering is governed
 * by `<`/`>` on whatever the stored value type is). String operations
 * coerce both sides via `String(...)` so they work on numbers too — the
 * IDB driver stores values via the structured-clone algorithm, so a
 * field that contains an integer is genuinely a JS `number`.
 */

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
      return cell === value;
    case "neq":
      if (value === null) return cell !== null && cell !== undefined;
      return cell !== value;
    case "gt":
      return cell !== undefined && cell !== null && (cell as number | string) > (value as number | string);
    case "lt":
      return cell !== undefined && cell !== null && (cell as number | string) < (value as number | string);
    case "gte":
      return cell !== undefined && cell !== null && (cell as number | string) >= (value as number | string);
    case "lte":
      return cell !== undefined && cell !== null && (cell as number | string) <= (value as number | string);
    case "in": {
      if (!Array.isArray(value)) return false;
      for (const v of value) {
        if (cell === v) return true;
      }
      return false;
    }
    case "notIn": {
      if (!Array.isArray(value)) return true;
      for (const v of value) {
        if (cell === v) return false;
      }
      return true;
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
