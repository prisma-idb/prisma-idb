import type { IdbKeyRangeDescriptor } from "@prisma-idb/driver-idb/runtime";
import { compareFieldValues, isValidIdbKey } from "@prisma-idb/target-idb/runtime";
import type { CatalogField, CatalogSource, QueryCatalog } from "../../src/core/planner/catalog";
import type { LogicalPlan } from "../../src/core/planner/plan";

export function source(
  keyPath: string | readonly string[],
  indexName?: string,
  unique = false,
  multiEntry = false
): CatalogSource {
  return {
    keyPath,
    fields: typeof keyPath === "string" ? [keyPath] : keyPath,
    unique,
    multiEntry,
    ...(indexName === undefined ? {} : { indexName }),
  };
}
export function field(codecId = "idb/string@1", nullable = false, collection = false): CatalogField {
  return { codecId, nullable, collection };
}
export function catalog(
  indexes: readonly CatalogSource[] = [],
  fields: Record<string, CatalogField> = {}
): QueryCatalog {
  return {
    storeName: "items",
    primaryKey: source("id", undefined, true),
    indexes,
    fields: { id: field(), a: field(), b: field(), c: field(), n: field("idb/int32@1"), ...fields },
  };
}

/** Independent membership oracle: compare each descriptor endpoint with the row's stored key. */
export function planContains(plan: LogicalPlan, row: Record<string, unknown>): boolean {
  if (plan.access.kind === "full") return true;
  if (plan.access.kind === "empty") return false;
  const path = plan.access.source.keyPath;
  const key = typeof path === "string" ? row[path] : path.map((name) => row[name]);
  return isValidIdbKey(key) && plan.access.ranges.some((range) => contains(range, key));
}
function contains(range: IdbKeyRangeDescriptor | undefined, key: IDBValidKey): boolean {
  if (!range) return true;
  switch (range.kind) {
    case "only":
      return compareFieldValues(key, range.key) === 0;
    case "lower":
      return compareFieldValues(key, range.key) >= (range.open ? 1 : 0);
    case "upper":
      return compareFieldValues(key, range.key) <= (range.open ? -1 : 0);
    case "bound":
      return (
        compareFieldValues(key, range.lower) >= (range.lowerOpen ? 1 : 0) &&
        compareFieldValues(key, range.upper) <= (range.upperOpen ? -1 : 0)
      );
  }
}
