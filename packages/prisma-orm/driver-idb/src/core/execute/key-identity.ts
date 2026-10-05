/**
 * A string that is equal for two `IDBValidKey`s exactly when IndexedDB considers the keys equal.
 *
 * `Set` compares arrays, dates and binary keys by reference, so it cannot track primary keys directly.
 * Each key type gets its own prefix so, for example, the string "1" and the number 1 stay distinct.
 *
 * Dates and binary keys are detected by their internal slots, not `instanceof`, because a key can come
 * from another realm (for example an iframe), where its constructors differ from this realm's.
 */
export function keyIdentity(key: IDBValidKey): string {
  if (typeof key === "number") return `n:${Object.is(key, -0) ? 0 : key}`;
  if (typeof key === "string") return `s:${JSON.stringify(key)}`;
  if (Array.isArray(key)) return `[${key.map(keyIdentity).join(",")}]`;
  if (ArrayBuffer.isView(key)) return binaryIdentity(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
  if (Object.prototype.toString.call(key) === "[object ArrayBuffer]")
    return binaryIdentity(new Uint8Array(key as ArrayBuffer));
  return `d:${Date.prototype.getTime.call(key)}`;
}

function binaryIdentity(bytes: Uint8Array): string {
  return `b:${bytes.join(".")}`;
}
