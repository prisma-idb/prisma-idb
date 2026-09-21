/**
 * Filter expression AST for IDB queries.
 *
 * Plain frozen objects (not classes) — IDB has no codec trait gating to
 * worry about and no visitor pattern needed (a recursive `evaluateFilter`
 * is plenty). Mirrors the design of Prisma ORM's Mongo family
 * (`MongoFieldFilter`, `MongoAndExpr`, ...) and the SQL ORM's `BinaryExpr`,
 * but with the class machinery stripped out.
 *
 * The AST is carried on `IdbQueryAst` (intent layer) and lowered into an
 * `IdbRowFilter` closure that the driver applies during cursor scans —
 * keeping the driver free of any AST imports.
 */

export type IdbFilterOp =
  "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "in" | "notIn" | "contains" | "startsWith" | "endsWith";

/** Comparison / membership predicate on a single field. */
export interface IdbFieldFilter {
  readonly kind: "field";
  readonly field: string;
  readonly op: IdbFilterOp;
  readonly value: unknown;
}

/** Conjunction. Empty `exprs` is truthy (vacuously true). */
export interface IdbAndExpr {
  readonly kind: "and";
  readonly exprs: ReadonlyArray<IdbFilterExpr>;
}

/** Disjunction. Empty `exprs` is falsy. */
export interface IdbOrExpr {
  readonly kind: "or";
  readonly exprs: ReadonlyArray<IdbFilterExpr>;
}

/** Logical NOT. */
export interface IdbNotExpr {
  readonly kind: "not";
  readonly expr: IdbFilterExpr;
}

/**
 * Null check. Distinct from `eq null` because IDB serialises absent
 * fields as `undefined`; a null check treats `null` and `undefined`
 * as equivalent (matching the shorthand `where({ field: null })`).
 */
export interface IdbNullCheckExpr {
  readonly kind: "null-check";
  readonly field: string;
  readonly isNull: boolean;
}

export type IdbFilterExpr = IdbFieldFilter | IdbAndExpr | IdbOrExpr | IdbNotExpr | IdbNullCheckExpr;

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Build a frozen field-filter node. */
export const fieldFilter = (field: string, op: IdbFilterOp, value: unknown): IdbFieldFilter =>
  Object.freeze({ kind: "field", field, op, value });

/** Build a frozen AND combinator with a frozen `exprs` array. */
export const andExpr = (exprs: ReadonlyArray<IdbFilterExpr>): IdbAndExpr =>
  Object.freeze({ kind: "and", exprs: Object.freeze([...exprs]) });

/** Build a frozen OR combinator with a frozen `exprs` array. */
export const orExpr = (exprs: ReadonlyArray<IdbFilterExpr>): IdbOrExpr =>
  Object.freeze({ kind: "or", exprs: Object.freeze([...exprs]) });

/** Build a frozen NOT combinator. */
export const notExpr = (expr: IdbFilterExpr): IdbNotExpr => Object.freeze({ kind: "not", expr });

/** Build a frozen null-check node. */
export const nullCheckExpr = (field: string, isNull: boolean): IdbNullCheckExpr =>
  Object.freeze({ kind: "null-check", field, isNull });

// ── Shorthand → expression ────────────────────────────────────────────────────

/**
 * Convert a shorthand equality object (e.g. `{ active: true, email: "x" }`)
 * into the canonical AST form. `undefined` entries are dropped; `null`
 * values become null-checks rather than literal-null equalities (IDB
 * stores absent fields as `undefined`, so a literal-null equality misses).
 *
 * Returns `undefined` when the input has no usable entries — callers can
 * skip filter installation in that case rather than testing an empty
 * AND node every row.
 */
export function shorthandToFilterExpr(filters: Record<string, unknown>): IdbFilterExpr | undefined {
  const exprs: IdbFilterExpr[] = [];
  for (const [field, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (value === null) {
      exprs.push(nullCheckExpr(field, true));
      continue;
    }
    exprs.push(fieldFilter(field, "eq", value));
  }
  if (exprs.length === 0) return undefined;
  return exprs.length === 1 ? exprs[0]! : andExpr(exprs);
}
