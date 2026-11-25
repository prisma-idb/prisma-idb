/**
 * Whether a plan key is a range rather than a single key. Duck-typed, since a
 * realm with an injected IndexedDB, such as fake-indexeddb outside a browser,
 * has no global `IDBKeyRange` for `instanceof`. A valid single key can be an
 * array, a date or binary data, and any of those can carry extra properties,
 * so they never count as ranges.
 */
export function isKeyRange(value: unknown): value is IDBKeyRange {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value) &&
    "lower" in value &&
    "upper" in value &&
    "lowerOpen" in value &&
    "upperOpen" in value
  );
}
