/**
 * A string that is equal for two `IDBValidKey`s exactly when IndexedDB considers the keys equal.
 *
 * `Set` compares arrays, dates and binary keys by reference, so it cannot track primary keys directly.
 * Each key type gets its own prefix so, for example, the string "1" and the number 1 stay distinct.
 */
export function keyIdentity(key: IDBValidKey): string {
  if (typeof key === "number") return `n:${Object.is(key, -0) ? 0 : key}`;
  if (typeof key === "string") return `s:${JSON.stringify(key)}`;
  if (key instanceof Date) return `d:${key.getTime()}`;
  if (Array.isArray(key)) return `[${key.map(keyIdentity).join(",")}]`;
  const bytes =
    key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  return `b:${bytes.join(".")}`;
}
