import type { IdbKeyRangeDescriptor } from "../plan-body";

/**
 * Builds the `IDBKeyRange` a plan's range descriptor stands for.
 *
 * Plans carry descriptors, not `IDBKeyRange` objects, so a plan stays plain data that callers can build,
 * hash and log without touching IndexedDB. Each descriptor maps to the `IDBKeyRange` factory of the same
 * name, so the factory's own validation applies: an invalid key, or `bound` with `lower` above `upper`,
 * throws `DataError`.
 */
export function toIdbKeyRange(range: IdbKeyRangeDescriptor): IDBKeyRange {
  switch (range.kind) {
    case "only":
      return IDBKeyRange.only(range.key);
    case "lower":
      return IDBKeyRange.lowerBound(range.key, range.open);
    case "upper":
      return IDBKeyRange.upperBound(range.key, range.open);
    case "bound":
      return IDBKeyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen);
  }
}

/**
 * `toIdbKeyRange` for an optional range. `undefined` means "no restriction", which IndexedDB expresses
 * as an absent query.
 */
export function toOptionalIdbKeyRange(range: IdbKeyRangeDescriptor | undefined): IDBKeyRange | undefined {
  return range === undefined ? undefined : toIdbKeyRange(range);
}
