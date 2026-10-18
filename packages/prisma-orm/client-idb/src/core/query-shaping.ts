import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import { andExpr } from "@prisma-idb/adapter-idb/runtime";
import type { IdbRowComparator } from "@prisma-idb/driver-idb/runtime";
import { compareDecimalValues, compareFieldValues, compareListValues } from "@prisma-idb/target-idb/runtime";
import type { CatalogField } from "./planner/catalog";

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
 * declaration order. Decimal fields use exact numeric order; other fields
 * use {@link compareFieldValues}: the same order an
 * IndexedDB index uses, so equal `Date`s tie and fall through to the next
 * field, and `null`s sort last (first when descending).
 */
export function buildRowComparator(
  orderBy: Readonly<Record<string, "asc" | "desc">> | undefined,
  fields: Readonly<Record<string, CatalogField>> = {}
): IdbRowComparator | undefined {
  if (orderBy === undefined) return undefined;
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    for (const [field, dir] of Object.entries(orderBy)) {
      const metadata = fields[field];
      const decimal = metadata?.codecId === "idb/decimal@1" && !metadata.collection;
      const present = a[field] != null && b[field] != null;
      const cmp =
        metadata?.collection && !metadata.dict && Array.isArray(a[field]) && Array.isArray(b[field])
          ? compareListValues(metadata.codecId, a[field] as unknown[], b[field] as unknown[])
          : decimal && present
            ? compareDecimalValues(a[field], b[field])
            : compareFieldValues(a[field], b[field]);
      if (cmp === 0) continue;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  };
}
