/**
 * Whether a plan key is a range rather than a single key. Duck-typed, since a
 * realm with an injected IndexedDB, such as fake-indexeddb outside a browser,
 * has no global `IDBKeyRange` for `instanceof`.
 */
export function isKeyRange(value: unknown): value is IDBKeyRange {
  return (
    typeof value === "object" &&
    value !== null &&
    "lower" in value &&
    "upper" in value &&
    "lowerOpen" in value &&
    "upperOpen" in value
  );
}
