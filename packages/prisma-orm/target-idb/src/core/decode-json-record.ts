import type {
  ApplicationDomain,
  ContractField,
  ContractValueObject,
  JsonValue,
} from "@prisma/orm-framework/contract/types";
import {
  domainModelsAtDefaultNamespace,
  domainValueObjectsAtDefaultNamespace,
} from "@prisma/orm-framework/contract/types";
import { idbCodecLookup } from "./codecs";

/**
 * Decode a plain JS record that arrived as wire JSON (e.g. an HTTP pull
 * payload sourced from a remote SQL database) into native storage values for
 * `modelName`.
 *
 * Walks `domain`'s model fields and applies each scalar field's `decodeJson`
 * (e.g. `idb/date@1`: ISO string → `Date`, `idb/bigint@1`: string → `bigint`,
 * `idb/bytes@1`: base64 → `Uint8Array`). Keys absent from the model pass through
 * unchanged. Union fields fail closed because no discriminant selects a member codec.
 */
export function decodeJsonRecord(
  domain: ApplicationDomain,
  modelName: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const model = domainModelsAtDefaultNamespace(domain)[modelName];
  if (!model) return record;
  return decodeFields(record, model.fields, domain, `Model "${modelName}"`);
}

/** Decodes declared fields and rejects unsupported types before reading their values. */
function decodeFields(
  record: Record<string, unknown>,
  fields: Record<string, ContractField>,
  domain: ApplicationDomain,
  owner: string
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const [key, field] of Object.entries(fields)) {
    if (field.type.kind === "union") {
      throw new Error(`${owner} field "${key}" uses a union type, which prisma-idb does not support`);
    }
    if (key in record) {
      out[key] = decodeFieldValue(record[key], field, domain, `${owner} field "${key}"`);
    }
  }
  return out;
}

/** Decodes a field container while preserving nullable values. */
function decodeFieldValue(
  value: unknown,
  field: ContractField,
  domain: ApplicationDomain,
  fieldLabel: string
): unknown {
  if (value === null || value === undefined) return value;
  if (field.many) {
    return Array.isArray(value) ? value.map((el) => decodeScalarOrValueObject(el, field, domain, fieldLabel)) : value;
  }
  if (field.dict) {
    return isPlainObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, decodeScalarOrValueObject(v, field, domain, fieldLabel)])
        )
      : value;
  }
  return decodeScalarOrValueObject(value, field, domain, fieldLabel);
}

/** Applies a scalar codec or recursively decodes an embedded value object. */
function decodeScalarOrValueObject(
  value: unknown,
  field: ContractField,
  domain: ApplicationDomain,
  fieldLabel: string
): unknown {
  if (value === null || value === undefined) return value;
  const { type } = field;
  if (type.kind === "scalar") {
    const codec = idbCodecLookup.get(type.codecId);
    return codec ? codec.decodeJson(value as JsonValue) : value;
  }
  if (type.kind === "valueObject") {
    if (!isPlainObject(value)) return value;
    const voDef: ContractValueObject | undefined = domainValueObjectsAtDefaultNamespace(domain)?.[type.name];
    return voDef ? decodeFields(value, voDef.fields, domain, `Value object "${type.name}"`) : value;
  }
  // Union fields are rejected by decodeFields before any container or value is read.
  throw new Error(`${fieldLabel} uses a union type, which prisma-idb does not support`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
