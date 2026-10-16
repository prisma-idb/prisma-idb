import { isValidIdbKey } from "@prisma-idb/target-idb/runtime";
import type { QueryCatalog } from "./planner/catalog";

/**
 * Copy the own enumerable properties of an upsert `where` once. Validation and
 * filter parsing then see the same values even when a property is a getter.
 * Non-object inputs pass through so `assertUniqueLookup` can reject them.
 */
export function snapshotLookup<Where>(where: Where): Where {
  const isRecord = typeof where === "object" && where !== null && !Array.isArray(where);
  return isRecord ? (Object.fromEntries(Object.entries(where)) as Where) : where;
}

/**
 * Require equality on a complete native unique key before upsert can mutate.
 * Null and other non-key values are absent from IndexedDB indexes, so even a
 * declared unique index cannot make those filters identify at most one row.
 */
export function assertUniqueLookup(catalog: QueryCatalog, where: Record<string, unknown>): void {
  const sources = [catalog.primaryKey, ...catalog.indexes];
  const validFilter = typeof where === "object" && where !== null && !Array.isArray(where);
  const unique =
    validFilter &&
    sources.some(
      (source) =>
        source.unique &&
        !source.multiEntry &&
        source.fields.length > 0 &&
        source.fields.every(
          (field) => Object.prototype.propertyIsEnumerable.call(where, field) && isValidIdbKey(where[field])
        )
    );
  if (!unique) {
    throw new Error(
      `Invalid upsert where for "${catalog.storeName}": provide a complete primary key or unique index with non-null IndexedDB key values`
    );
  }
}
