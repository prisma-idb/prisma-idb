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

/** SQL predicate result before the outer WHERE boundary discards unknown. */
type PredicateResult = boolean | null;

/** Evaluate an AST node against a single row. Only SQL TRUE keeps the row. */
export function evaluateFilter(
  expr: IdbFilterExpr,
  row: Record<string, unknown>,
  fields: FilterFieldMetadata = {}
): boolean {
  return evaluatePredicate(expr, row, fields) === true;
}

/** Preserve unknown through logical composition so negation cannot admit null comparisons. */
function evaluatePredicate(
  expr: IdbFilterExpr,
  row: Record<string, unknown>,
  fields: FilterFieldMetadata
): PredicateResult {
  switch (expr.kind) {
    case "field":
      return evalFieldOp(expr.field, expr.op, expr.value, row, fields);
    case "and": {
      let result: PredicateResult = true;
      for (const e of expr.exprs) {
        const child = evaluatePredicate(e, row, fields);
        if (child === false) return false;
        if (child === null) result = null;
      }
      return result;
    }
    case "or": {
      let result: PredicateResult = false;
      for (const e of expr.exprs) {
        const child = evaluatePredicate(e, row, fields);
        if (child === true) return true;
        if (child === null) result = null;
      }
      return result;
    }
    case "not": {
      const result = evaluatePredicate(expr.expr, row, fields);
      return result === null ? null : !result;
    }
    case "null-check": {
      const isNullish = !isPresent(row[expr.field]);
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
): PredicateResult {
  const cell = row[field];
  // Upstream eq(null) and neq(null) are explicit null checks, not SQL comparisons.
  if (value === null && (op === "eq" || op === "neq")) {
    return op === "eq" ? !isPresent(cell) : isPresent(cell);
  }
  const decimal = isDecimalField(fields, field);
  const compare = decimal ? compareDecimalValues : compareFieldValues;
  const equal = decimal ? (a: unknown, b: unknown) => compareDecimalValues(a, b) === 0 : fieldValuesEqual;
  if (op === "in" || op === "notIn") {
    const result = evaluateMembership(cell, value, equal);
    if (result === null) return null;
    return op === "in" ? result : !result;
  }
  if (!isPresent(cell) || !isPresent(value)) return null;

  switch (op) {
    case "eq":
      return equal(cell, value);
    case "neq":
      return !equal(cell, value);
    case "gt":
      return compare(cell, value) > 0;
    case "lt":
      return compare(cell, value) < 0;
    case "gte":
      return compare(cell, value) >= 0;
    case "lte":
      return compare(cell, value) <= 0;
    case "contains":
      return String(cell).includes(String(value));
    case "startsWith":
      return String(cell).startsWith(String(value));
    case "endsWith":
      return String(cell).endsWith(String(value));
    default:
      return false;
  }
}

/** Match SQL IN: empty lists are false; otherwise null operands leave an unmatched result unknown. */
function evaluateMembership(
  cell: unknown,
  values: unknown,
  equal: (a: unknown, b: unknown) => boolean
): PredicateResult {
  if (!Array.isArray(values) || values.length === 0) return false;
  if (!isPresent(cell)) return null;
  let result: PredicateResult = false;
  for (const value of values) {
    if (!isPresent(value)) result = null;
    else if (equal(cell, value)) return true;
  }
  return result;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}
