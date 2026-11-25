/**
 * How sync values cross the JSON wire between the IDB client and the SQL
 * server: the codecs both sides share, `encodeWireKey` for keys going out and
 * `reviveWireKey`/`reviveWireValues` for keys and payloads coming in. Push and
 * pull both depend on it.
 */

import { codecValueFromJson, codecValueToJson, idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField, SyncServerContract } from "@prisma-idb/sync-server";

// These SQL codecs use the same JSON representation as the IDB client.
const nativeJsonCodecs: Record<string, string> = {
  "pg/date@1": "idb/date@1",
  "pg/timestamp@1": "idb/date@1",
  "pg/timestamp-date@1": "idb/date@1",
  "pg/timestamptz@1": "idb/date@1",
  "pg/timestamptz-date@1": "idb/date@1",
  "sql/timestamp@1": "idb/date@1",
  "pg/int8@1": "idb/bigint@1",
  "pg/unboundedint@1": "idb/bigint@1",
  "pg/bytea@1": "idb/bytes@1",
  "pg/json@1": "idb/json@1",
  "pg/jsonb@1": "idb/json@1",
};

function fieldsForModel(contract: SyncServerContract, model: string) {
  return domainModelsAtDefaultNamespace(contract.domain)[model]?.fields;
}

/** Encode a native SQL key for comparison with a wire-form scope key. */
export function encodeWireKey(contract: SyncServerContract, model: string, keyField: string, key: unknown): unknown {
  const fields = fieldsForModel(contract, model);
  const field = fields && Object.hasOwn(fields, keyField) ? fields[keyField] : undefined;
  const codecId = field?.type.kind === "scalar" ? nativeJsonCodecs[field.type.codecId] : undefined;
  const codec = codecId ? idbCodecLookup.get(codecId) : undefined;
  return codec && key != null ? codecValueToJson(codec, key) : canonicalFloat4Key(contract, model, keyField, key);
}

/**
 * Encode a native SQL row as sync wire JSON, the counterpart of `reviveWireValues`:
 * `bigint` becomes a string and bytes become base64, as the IDB client decodes them.
 * `JSON.stringify` would otherwise throw on a `bigint` and turn bytes into a
 * numeric-keyed object.
 */
export function encodeWireValues(
  contract: SyncServerContract,
  model: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const fields = fieldsForModel(contract, model);
  if (!fields) return record;
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
      const codecId = field?.type.kind === "scalar" ? nativeJsonCodecs[field.type.codecId] : undefined;
      const codec = codecId ? idbCodecLookup.get(codecId) : undefined;
      if (!codec || value === null || value === undefined) return [name, value];
      if (codecId === "idb/json@1") return [name, codecValueToJson(codec, value)];
      const encode = (input: unknown): unknown => (input === null ? input : codecValueToJson(codec, input));
      if (field?.many && Array.isArray(value)) return [name, value.map(encode)];
      return [name, encode(value)];
    })
  );
}

/** A sync payload value or key that cannot be decoded or shaped; `code` is the stable wire error code, `message` keeps the diagnostic for direct callers. */
export class WireValidationError extends Error {
  constructor(
    readonly code: "RECORD_VALIDATION_FAILURE" | "KEYPATH_VALIDATION_FAILURE",
    message: string
  ) {
    super(message);
  }
}

/** Revive native sync scalar values before shape validation or ORM encoding. */
export function reviveWireValues(
  contract: SyncServerContract,
  model: string,
  data: Record<string, unknown>,
  keyField?: string
): Record<string, unknown> {
  const fields = fieldsForModel(contract, model);
  if (!fields) return data;
  return Object.fromEntries(
    Object.entries(data).map(([name, value]) => {
      const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
      const codecId = field?.type.kind === "scalar" ? nativeJsonCodecs[field.type.codecId] : undefined;
      const codec = codecId ? idbCodecLookup.get(codecId) : undefined;
      if (!codec) return [name, value];
      const revive = (input: unknown): unknown => {
        if (typeof input !== "string") return input;
        try {
          return codecValueFromJson(codec, input);
        } catch {
          throw new WireValidationError(
            name === keyField ? "KEYPATH_VALIDATION_FAILURE" : "RECORD_VALIDATION_FAILURE",
            "Unable to decode sync field"
          );
        }
      };
      if (field?.many && Array.isArray(value)) return [name, value.map(revive)];
      return [name, revive(value)];
    })
  );
}

/** Revive one wire-form key; the counterpart of `encodeWireKey`. */
export function reviveWireKey(contract: SyncServerContract, model: string, keyField: string, key: unknown): unknown {
  return reviveWireValues(contract, model, { [keyField]: key }, keyField)[keyField];
}

/** PostgreSQL can return a shorter decimal spelling of a float4 key. */
export function canonicalFloat4Key(
  contract: SyncServerContract,
  model: string,
  keyField: string,
  key: unknown
): unknown {
  const field = fieldsForModel(contract, model)?.[keyField];
  return typeof key === "number" && field?.type.kind === "scalar" && field.type.codecId === "pg/float4@1"
    ? Math.fround(key)
    : key;
}

interface SqlModelStorage {
  readonly table?: string;
  readonly namespaceId?: string;
  readonly fields?: Readonly<Record<string, { readonly column?: string }>>;
}

interface SqlForeignKey {
  readonly source: { readonly columns: readonly string[] };
  readonly target: { readonly namespaceId: string; readonly tableName: string; readonly columns: readonly string[] };
}

/** A one-to-one relation describes both sides. Only the side with the SQL foreign key references the other row. */
function ownsSingleColumnForeignKey(
  contract: SyncServerContract,
  source: SqlModelStorage,
  localField: string,
  target: SqlModelStorage,
  targetField: string
): boolean {
  const namespaces = (
    contract.storage as {
      namespaces?: Record<string, { entries?: { table?: Record<string, { foreignKeys?: readonly SqlForeignKey[] }> } }>;
    }
  ).namespaces;
  if (!source.namespaceId || !source.table || !target.namespaceId || !target.table) return false;
  const foreignKeys = namespaces?.[source.namespaceId]?.entries?.table?.[source.table]?.foreignKeys ?? [];
  return foreignKeys.some(
    ({ source: from, target: to }) =>
      from.columns.length === 1 &&
      from.columns[0] === (source.fields?.[localField]?.column ?? localField) &&
      to.namespaceId === target.namespaceId &&
      to.tableName === target.table &&
      to.columns.length === 1 &&
      to.columns[0] === (target.fields?.[targetField]?.column ?? targetField)
  );
}

/** Preserve the identity of float4 primary keys and the projected foreign keys that point to them. */
export function canonicalizeRecordFloat4Keys(
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  keyField: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const key = record[keyField];
  const canonicalKey = canonicalFloat4Key(contract, model, keyField, key);
  let result = Object.is(key, canonicalKey) ? record : { ...record, [keyField]: canonicalKey };

  const models = domainModelsAtDefaultNamespace(contract.domain);
  const source = models[model];
  if (!source) return result;
  for (const relation of Object.values(source.relations)) {
    if ((relation.cardinality !== "N:1" && relation.cardinality !== "1:1") || !("on" in relation)) continue;
    const { localFields, targetFields } = relation.on;
    const [localField] = localFields;
    const [targetField] = targetFields;
    if (localFields.length !== 1 || targetFields.length !== 1 || !localField || !targetField) continue;
    if (!Object.hasOwn(record, localField)) continue;

    const value = record[localField];
    const canonical = canonicalFloat4Key(contract, model, localField, value);
    if (Object.is(value, canonical)) continue;

    const targetModel = relation.to.model;
    const target = models[targetModel];
    if (!target) continue;
    const targetType = target.fields[targetField]?.type;
    if (targetType?.kind !== "scalar" || targetType.codecId !== "pg/float4@1") continue;
    try {
      if (getKeyField(contract, targetModel) !== targetField) continue;
    } catch {
      // An unrelated relation can reference a model without a supported sync key.
      continue;
    }
    if (
      relation.cardinality === "1:1" &&
      !ownsSingleColumnForeignKey(contract, source.storage, localField, target.storage, targetField)
    )
      continue;
    if (result === record) result = { ...record };
    result[localField] = canonical;
  }
  return result;
}

export function assertFloat4KeyFits(contract: SyncServerContract, model: string, keyField: string, key: unknown): void {
  if (!Object.is(canonicalFloat4Key(contract, model, keyField, key), key)) {
    throw new WireValidationError(
      "KEYPATH_VALIDATION_FAILURE",
      "The key must be exactly representable as PostgreSQL float4"
    );
  }
}

// Integer codecs have a signed range. Float codecs accept finite wire numbers.
const numericKeyLimits = new Map<string, number | null>([
  ["sql/int@1", 2 ** 31],
  ["pg/int@1", 2 ** 31],
  ["pg/int2@1", 2 ** 15],
  ["pg/int4@1", 2 ** 31],
  ["pg/int8number@1", 2 ** 53],
  ["sql/float@1", null],
  ["pg/float@1", null],
  ["pg/float4@1", null],
  ["pg/float8@1", null],
]);

/** Restore a numeric key from the changelog's text column. */
export function decodeStoredNumericKey(
  contract: SyncServerContract,
  model: string,
  keyField: string,
  key: unknown
): unknown {
  if (typeof key !== "string") {
    assertFloat4KeyFits(contract, model, keyField, key);
    return key;
  }
  const field = fieldsForModel(contract, model)?.[keyField];
  const limit = field?.type.kind === "scalar" ? numericKeyLimits.get(field.type.codecId) : undefined;
  if (limit === undefined) return key;

  const value = Number(key);
  // Changelog writes use the ordinary string representation of a wire number.
  const outsideRange = limit !== null && (!Number.isSafeInteger(value) || value < -limit || value >= limit);
  if (!Number.isFinite(value) || String(value) !== key || outsideRange) {
    throw new WireValidationError("KEYPATH_VALIDATION_FAILURE", "Invalid numeric changelog key");
  }
  // A historical push may have logged the input before PostgreSQL rounded it.
  assertFloat4KeyFits(contract, model, keyField, value);
  return value;
}
