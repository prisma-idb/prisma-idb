/**
 * How IndexedDB compares values, for code that has to match it outside a key
 * range: in-memory filters, sorting, and joins on foreign keys.
 *
 * `Date`s, binary values and arrays read back from IndexedDB are fresh
 * objects, so `===` never matches two equal ones. These helpers compare them
 * the way IndexedDB compares keys, so a query gives the same answer whether it
 * runs through an index or through an in-memory filter.
 */

/**
 * Returns `true` when `value` is a valid {@link IDBValidKey} — i.e. a value
 * that can be passed to `IDBKeyRange.only()` without throwing a DataError.
 * Only numbers (not `NaN`), strings, valid `Date`s, binary values and arrays
 * of valid keys are keys, per the IndexedDB spec. Booleans, `BigInt`, plain
 * objects, `null`/`undefined` and invalid `Date`s are not. An array is a key
 * only if every element is, it has no holes, and no array appears in it
 * twice (which also rules out cycles), as in the spec.
 *
 * Shared by the relation loader (filtering FK values before building
 * `IDBKeyRange.only()` plans) and query-shaping (gating `eq` conditions for
 * index/PK point-range acceleration).
 */
export function isValidIdbKey(value: unknown): value is IDBValidKey {
  return isValidKey(value, new Set());
}

function isValidKey(value: unknown, seen: Set<unknown>): boolean {
  if (typeof value === "number") return !Number.isNaN(value);
  if (typeof value === "string") return true;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || !isValidKey(value[i], seen)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Structural equality between two {@link IDBValidKey} values. Plain `===`/`!==`
 * is wrong for a compound (array) key — two freshly-constructed arrays with
 * identical contents are never `===`. Recurses so nested-array keys (a
 * compound key with a `Bytes`/`ArrayBuffer` member, or a key genuinely
 * containing a nested array) compare correctly too.
 */
export function keyEquals(a: IDBValidKey, b: IDBValidKey): boolean {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB.cmp(a, b) === 0;
  } catch {
    // cmp throws DataError for non-keys; fall through to structural comparison.
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => keyEquals(v as IDBValidKey, b[i] as IDBValidKey));
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  const ab = binaryBytes(a);
  const bb = binaryBytes(b);
  if (ab !== null || bb !== null) {
    return ab !== null && bb !== null && ab.length === bb.length && ab.every((v, i) => v === bb[i]);
  }
  return a === b;
}

function binaryBytes(key: unknown): Uint8Array | null {
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  if (ArrayBuffer.isView(key)) return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  return null;
}

function tokenPart(key: unknown): unknown {
  if (Array.isArray(key)) return ["a", key.map(tokenPart)];
  if (key instanceof Date) return ["d", key.getTime()];
  const bytes = binaryBytes(key);
  if (bytes !== null) return ["b", Array.from(bytes)];
  if (typeof key === "number") return ["n", Object.is(key, -0) ? 0 : String(key)];
  return ["s", String(key)];
}

/**
 * A stable, comparable token for a key — for `Set`/`Map` dedup keys where a
 * raw key can't be used directly (arrays, `Date`s and binary keys are never
 * `===`/never hash the same in a `Set`). Plain string/number keys keep
 * `String(key)` (also used in error messages); every other shape is encoded
 * recursively with type tags so `1` vs `"1"`, equal Dates and equal bytes
 * are distinguished/matched correctly.
 */
export function keyToken(key: IDBValidKey): string {
  if (typeof key === "string" || typeof key === "number") return String(key);
  return JSON.stringify(tokenPart(key));
}

/**
 * Equality for two relation/FK field values, as IndexedDB would match them.
 * Plain `===` for primitives and `null`/`undefined`; key equality for
 * object-shaped keys (`Date`, binary, arrays), which are never `===` once read
 * back from IDB — e.g. a `DateTime` FK against its parent's `DateTime` key.
 */
export function fieldValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return isValidIdbKey(a) && isValidIdbKey(b) && keyEquals(a, b);
}

/**
 * A `Map`/`Set` key for a relation/FK field value. Object-shaped keys (`Date`,
 * binary, arrays) become a {@link keyToken} string so equal values collapse to
 * the same entry. Strings get a different prefix, so no string can equal an
 * object's token. Other primitives pass through unchanged.
 */
export function fieldValueToken(value: unknown): unknown {
  if (typeof value === "string") return `\u0000s${value}`;
  if (typeof value === "object" && value !== null && isValidIdbKey(value)) return `\u0000o${keyToken(value)}`;
  return value;
}

/**
 * Orders two field values for `orderBy` and for `gt`/`gte`/`lt`/`lte`.
 *
 * - Valid IndexedDB keys are ordered the way IndexedDB orders them, so an
 *   in-memory sort agrees with an index scan. Across types that means
 *   number < `Date` < string < binary < array.
 * - `null` and `undefined` sort after every other value, like `NULLS LAST`
 *   in Postgres. A descending sort reverses this, so they come first.
 * - Anything else, such as booleans or `bigint`, falls back to JavaScript's
 *   `<` and `>`.
 */
export function compareFieldValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (isValidIdbKey(a) && isValidIdbKey(b)) return compareKeys(a, b);
  if (a === b) return 0;
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

const KEY_TYPE_RANK = { number: 0, date: 1, string: 2, binary: 3, array: 4 } as const;

function keyTypeRank(key: IDBValidKey): number {
  if (typeof key === "number") return KEY_TYPE_RANK.number;
  if (key instanceof Date) return KEY_TYPE_RANK.date;
  if (typeof key === "string") return KEY_TYPE_RANK.string;
  if (Array.isArray(key)) return KEY_TYPE_RANK.array;
  return KEY_TYPE_RANK.binary;
}

function compareKeys(a: IDBValidKey, b: IDBValidKey): number {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB.cmp(a, b);
  } catch {
    // An invalid `Date` makes cmp throw; fall through to the structural comparison.
  }
  const rankDiff = keyTypeRank(a) - keyTypeRank(b);
  if (rankDiff !== 0) return Math.sign(rankDiff);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const cmp = compareKeys(a[i] as IDBValidKey, b[i] as IDBValidKey);
      if (cmp !== 0) return cmp;
    }
    return Math.sign(a.length - b.length);
  }
  if (a instanceof Date && b instanceof Date) return Math.sign(a.getTime() - b.getTime());
  const ab = binaryBytes(a);
  const bb = binaryBytes(b);
  if (ab !== null && bb !== null) {
    for (let i = 0; i < Math.min(ab.length, bb.length); i++) {
      if (ab[i] !== bb[i]) return (ab[i] as number) < (bb[i] as number) ? -1 : 1;
    }
    return Math.sign(ab.length - bb.length);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
