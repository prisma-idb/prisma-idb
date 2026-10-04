/** Scalar type names supported by both contract-authoring formats. */
export type PrismaScalarType =
  "String" | "Int" | "Float" | "Boolean" | "DateTime" | "BigInt" | "Decimal" | "Json" | "Bytes";

/** Shared codec mapping; insertion order also determines the supported-type diagnostic. */
export const SCALAR_TO_CODEC_ID: Record<PrismaScalarType, string> = {
  String: "idb/string@1",
  Int: "idb/int32@1",
  Float: "idb/double@1",
  Boolean: "idb/bool@1",
  DateTime: "idb/date@1",
  BigInt: "idb/bigint@1",
  Decimal: "idb/decimal@1",
  Json: "idb/json@1",
  Bytes: "idb/bytes@1",
};

/** Returns whether a literal default has the JavaScript type expected by the field codec. */
export function literalValueMatchesCodec(value: string | number | boolean, codecId: string): boolean {
  switch (codecId) {
    case SCALAR_TO_CODEC_ID["String"]:
      return typeof value === "string";
    case SCALAR_TO_CODEC_ID["Int"]:
    case SCALAR_TO_CODEC_ID["Float"]:
    case SCALAR_TO_CODEC_ID["Decimal"]:
      return typeof value === "number";
    case SCALAR_TO_CODEC_ID["Boolean"]:
      return typeof value === "boolean";
    default:
      return false;
  }
}

/**
 * Codecs excluded from IndexedDB's "valid key" algorithm
 * (https://w3c.github.io/IndexedDB/#key-construct: number, string, Date,
 * buffer source, or Array — nothing else).
 *
 * - `idb/bool@1` — boolean is not, and has never been, a valid IDB key type.
 * - `idb/bigint@1` — bigint round-trips fine as a stored *value* (structured
 *   clone supports it), but is explicitly absent from the key-type algorithm.
 * - `idb/json@1` — arbitrary shape (object, array, or primitive); can't be
 *   statically guaranteed to be a valid key.
 *
 * Using any of these as a model's `@id`/key throws on every write
 * (`DataError` extracting the primary key). Using one as an index `keyPath`
 * doesn't throw on write — the record is just silently omitted from that
 * index — but throws the first time anyone queries it via `IDBKeyRange`
 * (see ADR 016's Context: `OutboxEvent.synced`, `idb/bool@1`, exactly this).
 */
const IDB_INVALID_KEY_CODEC_IDS = new Set(["idb/bool@1", "idb/bigint@1", "idb/json@1"]);

/** `true` if `codecId`'s runtime representation is a valid IndexedDB key. */
export function isValidIdbKeyCodec(codecId: string): boolean {
  return !IDB_INVALID_KEY_CODEC_IDS.has(codecId);
}

/**
 * `"full"` interprets the schema as-is (today's behavior, unchanged — this is
 * the server-facing shape). `"client"` additionally strips anything marked
 * `@idb.exclude`/`@@idb.exclude`, producing the projected client contract.
 *
 * A surviving model's relation (any cardinality, required or optional) to an
 * excluded model is dropped (with a warning), keeping the underlying FK
 * scalar field — the model itself is never excluded as a result (ADR 013;
 * see its §"Why we don't cascade on requiredness"). Field-level excludes
 * that entangle with a relation (excluding an FK column, or the relation
 * field itself) remain unsupported and are reported as diagnostics — a
 * different, still out-of-scope case ADR 013 doesn't cover.
 */
export type ContractProjection = "full" | "client";

/** Warns when client projection drops a relation to an excluded model (ADR 013). */
export function warnDroppedRelation(modelName: string, relationName: string, targetModel: string): void {
  console.warn(
    `[prisma-idb] Dropped relation "${modelName}.${relationName}" from the client contract: target model "${targetModel}" is excluded. The relation's scalar fields are kept.`
  );
}
