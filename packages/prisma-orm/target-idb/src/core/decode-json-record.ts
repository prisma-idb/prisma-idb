import type {
  ContractField,
  ContractValueObjectField,
  ContractWithDomain,
  JsonValue,
} from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace, valueObjectAt } from "@prisma/orm-framework/contract/types";
import { codecValueFromJson, codecValueToJson, idbCodecLookup } from "./codecs";
import { isJsonCodec } from "./json-value";

/**
 * Decode a plain JS record that arrived as wire JSON (e.g. an HTTP pull
 * payload sourced from a remote SQL database) into native storage values for
 * `modelName`.
 *
 * Walks the contract's model fields and reads each scalar field through its codec
 * (e.g. `idb/date@1`: ISO string → `Date`, `idb/bigint@1`: string → `bigint`,
 * `idb/bytes@1`: base64 → `Uint8Array`). Keys absent from the model pass through
 * unchanged. Union fields fail closed because no discriminant selects a member codec.
 */
export function decodeJsonRecord(
  contract: ContractWithDomain,
  modelName: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const models = domainModelsAtDefaultNamespace(contract.domain);
  const model = Object.hasOwn(models, modelName) ? models[modelName] : undefined;
  if (!model) return record;
  return decodeFields(record, model.fields, contract, `Model "${modelName}"`);
}

/**
 * Encode a native record for `modelName` as wire JSON: the inverse of
 * {@link decodeJsonRecord}. Each scalar field is written through its codec
 * (`bigint` → string, `Uint8Array` → base64, `Date` → ISO string), so
 * `JSON.stringify` neither throws nor turns bytes into a numeric-keyed object.
 * Keys absent from the model pass through unchanged.
 */
export function encodeJsonRecord(
  contract: ContractWithDomain,
  modelName: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const models = domainModelsAtDefaultNamespace(contract.domain);
  const model = Object.hasOwn(models, modelName) ? models[modelName] : undefined;
  if (!model) return record;
  return mapFields(record, model.fields, contract, `Model "${modelName}"`, encodeScalar);
}

/** Encode one scalar or value-object field value as wire JSON, the inverse of decoding it. */
export function encodeJsonFieldValue(
  contract: ContractWithDomain,
  modelName: string,
  fieldName: string,
  value: unknown
): unknown {
  const models = domainModelsAtDefaultNamespace(contract.domain);
  const fields = Object.hasOwn(models, modelName) ? models[modelName]?.fields : undefined;
  const field = fields && Object.hasOwn(fields, fieldName) ? fields[fieldName] : undefined;
  if (!field) return value;
  return mapFields({ [fieldName]: value }, { [fieldName]: field }, contract, `Model "${modelName}"`, encodeScalar)[
    fieldName
  ];
}

type ScalarMapper = (value: unknown, codecId: string) => unknown;

function encodeScalar(value: unknown, codecId: string): unknown {
  const codec = idbCodecLookup.get(codecId);
  return codec ? codecValueToJson(codec, value) : value;
}

/** Applies `mapScalar` to every declared scalar, including list, dict and value-object members. */
function mapFields(
  record: Record<string, unknown>,
  fields: Record<string, ContractField | ContractValueObjectField>,
  contract: ContractWithDomain,
  owner: string,
  mapScalar: ScalarMapper
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const [key, field] of Object.entries(fields)) {
    if (field.type.kind === "union") {
      throw new Error(`${owner} field "${key}" uses a union type, which prisma-idb does not support`);
    }
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (field.type.kind === "scalar" && isJsonCodec(field.type.codecId)) {
      // Check the whole value so a sparse Json list or a non-JSON element can't silently change.
      out[key] = mapScalar(value, "idb/json@1");
      continue;
    }
    const mapOne = (value: unknown): unknown => {
      if (value === null || value === undefined) return value;
      if (field.type.kind === "scalar") return mapScalar(value, field.type.codecId);
      if (field.type.kind === "valueObject" && isPlainObject(value)) {
        const voDef = valueObjectAt(contract.storage, field.type);
        return voDef
          ? mapFields(value, voDef.fields, contract, `Value object "${field.type.entityName}"`, mapScalar)
          : value;
      }
      return value;
    };
    if (value === null || value === undefined) continue;
    if (field.many) out[key] = Array.isArray(value) ? value.map(mapOne) : value;
    else if (field.dict)
      out[key] = isPlainObject(value)
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapOne(v)]))
        : value;
    else out[key] = mapOne(value);
  }
  return out;
}

/** Decodes declared fields and rejects unsupported types before reading their values. */
function decodeFields(
  record: Record<string, unknown>,
  fields: Record<string, ContractField | ContractValueObjectField>,
  contract: ContractWithDomain,
  owner: string
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const [key, field] of Object.entries(fields)) {
    if (field.type.kind === "union") {
      throw new Error(`${owner} field "${key}" uses a union type, which prisma-idb does not support`);
    }
    if (Object.hasOwn(record, key)) {
      out[key] = decodeFieldValue(record[key], field, contract, `${owner} field "${key}"`);
    }
  }
  return out;
}

/** Decodes a field container while preserving nullable values. */
function decodeFieldValue(
  value: unknown,
  field: ContractField | ContractValueObjectField,
  contract: ContractWithDomain,
  fieldLabel: string
): unknown {
  if (value === null || value === undefined) return value;
  if (field.many) {
    return Array.isArray(value)
      ? value.map((el) => (el === null ? el : decodeScalarOrValueObject(el, field, contract, fieldLabel)))
      : value;
  }
  if (field.dict) {
    return isPlainObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, decodeScalarOrValueObject(v, field, contract, fieldLabel)])
        )
      : value;
  }
  return decodeScalarOrValueObject(value, field, contract, fieldLabel);
}

/** Applies a scalar codec or recursively decodes an embedded value object. */
function decodeScalarOrValueObject(
  value: unknown,
  field: ContractField | ContractValueObjectField,
  contract: ContractWithDomain,
  fieldLabel: string
): unknown {
  if (value === null || value === undefined) return value;
  const { type } = field;
  if (type.kind === "scalar") {
    const codec = idbCodecLookup.get(type.codecId);
    return codec ? codecValueFromJson(codec, value as JsonValue) : value;
  }
  if (type.kind === "valueObject") {
    if (!isPlainObject(value)) return value;
    const voDef = valueObjectAt(contract.storage, type);
    return voDef ? decodeFields(value, voDef.fields, contract, `Value object "${type.entityName}"`) : value;
  }
  // Union fields are rejected by decodeFields before any container or value is read.
  throw new Error(`${fieldLabel} uses a union type, which prisma-idb does not support`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
