import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import { andExpr } from "@prisma-idb/adapter-idb/runtime";
import type { IdbRowComparator } from "@prisma-idb/driver-idb/runtime";
import { compareFieldValues } from "@prisma-idb/target-idb/runtime";

/**
 * Combine accumulated filter expressions with AND.
 *
 * Returns `undefined` when no filter is present so callers can skip building a
 * row-filter closure. Shared by {@link IdbStoreAccessorImpl} (top-level scans)
 * and the relation loader (refined `include()` child scans).
 */
export function combineFilterExprs(filters: ReadonlyArray<IdbFilterExpr>): IdbFilterExpr | undefined {
  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return andExpr(filters);
}

/**
 * Build an in-memory comparator from an `orderBy` spec (field → direction).
 *
 * Returns `undefined` when there is nothing to sort by. Compares fields in
 * declaration order, with {@link compareFieldValues}: the same order an
 * IndexedDB index uses, so equal `Date`s tie and fall through to the next
 * field, and `null`s sort last (first when descending).
 */
export function buildRowComparator(orderBy: Record<string, "asc" | "desc"> | undefined): IdbRowComparator | undefined {
  if (orderBy === undefined) return undefined;
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    for (const [field, dir] of Object.entries(orderBy)) {
      const cmp = compareFieldValues(a[field], b[field]);
      if (cmp === 0) continue;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  };
}
