/**
 * User-facing logical combinators for the IDB ORM.
 *
 * `and(a, b, ...)`, `or(a, b, ...)`, `not(e)` — thin wrappers over the
 * frozen factory helpers in `adapter-idb` that exist so callers don't
 * have to import from the adapter package directly. Mirrors the
 * `where { AND, OR, NOT }` shape Prisma users are already familiar with,
 * exposed as plain functions to keep the AST construction explicit.
 */

import {
  andExpr,
  notExpr,
  orExpr,
  type IdbAndExpr,
  type IdbFilterExpr,
  type IdbNotExpr,
  type IdbOrExpr,
} from "@prisma-idb/adapter-idb/runtime";

/** Variadic AND. `and()` (no args) is vacuously true. */
export function and(...exprs: ReadonlyArray<IdbFilterExpr>): IdbAndExpr {
  return andExpr(exprs);
}

/** Variadic OR. `or()` (no args) is vacuously false. */
export function or(...exprs: ReadonlyArray<IdbFilterExpr>): IdbOrExpr {
  return orExpr(exprs);
}

/** Logical NOT. */
export function not(expr: IdbFilterExpr): IdbNotExpr {
  return notExpr(expr);
}
