import type { IdbKeyRangeDescriptor } from "../plan-body";

/**
 * Builds the `IDBKeyRange` a plan's range descriptor stands for.
 *
 * The `range` fields of a plan carry descriptors, not `IDBKeyRange` objects, so that part of a plan stays
 * plain data that callers can build, hash and log without touching IndexedDB. Each descriptor maps to the `IDBKeyRange` factory of the same
 * name, so the factory's own validation applies: an invalid key, or `bound` with `lower` above `upper`,
 * throws `DataError`.
 */
export function toIdbKeyRange(
  range: IdbKeyRangeDescriptor,
  keyRange: typeof IDBKeyRange | undefined = globalThis.IDBKeyRange
): IDBKeyRange {
  if (keyRange === undefined) {
    throw new Error(
      "IDB: no IDBKeyRange is available. Pass `keyRange` with `factory` when the global scope has no IndexedDB."
    );
  }
  switch (range.kind) {
    case "only":
      return keyRange.only(range.key);
    case "lower":
      return keyRange.lowerBound(range.key, range.open);
    case "upper":
      return keyRange.upperBound(range.key, range.open);
    case "bound":
      return keyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen);
  }
}

/**
 * `toIdbKeyRange` for an optional range. `undefined` means "no restriction", which IndexedDB expresses
 * as an absent query.
 */
export function toOptionalIdbKeyRange(
  range: IdbKeyRangeDescriptor | undefined,
  keyRange?: typeof IDBKeyRange
): IDBKeyRange | undefined {
  return range === undefined ? undefined : toIdbKeyRange(range, keyRange);
}
