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
 * `idb/bytes@1`: base64 → `Uint8Array`). Keys absent from the model, or typed
 * as a `union` (no discriminant here to pick a member codec), pass through
 * unchanged.
 */
export function decodeJsonRecord(
  domain: ApplicationDomain,
  modelName: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const model = domainModelsAtDefaultNamespace(domain)[modelName];
  if (!model) return record;
  return decodeFields(record, model.fields, domain);
}

function decodeFields(
  record: Record<string, unknown>,
  fields: Record<string, ContractField>,
  domain: ApplicationDomain
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const [key, field] of Object.entries(fields)) {
    if (key in record) {
      out[key] = decodeFieldValue(record[key], field, domain);
    }
  }
  return out;
}

function decodeFieldValue(value: unknown, field: ContractField, domain: ApplicationDomain): unknown {
  if (value === null || value === undefined) return value;
  if (field.many) {
    return Array.isArray(value) ? value.map((el) => decodeScalarOrValueObject(el, field, domain)) : value;
  }
  if (field.dict) {
    return isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeScalarOrValueObject(v, field, domain)]))
      : value;
  }
  return decodeScalarOrValueObject(value, field, domain);
}

function decodeScalarOrValueObject(value: unknown, field: ContractField, domain: ApplicationDomain): unknown {
  if (value === null || value === undefined) return value;
  const { type } = field;
  if (type.kind === "scalar") {
    const codec = idbCodecLookup.get(type.codecId);
    return codec ? codec.decodeJson(value as JsonValue) : value;
  }
  if (type.kind === "valueObject") {
    if (!isPlainObject(value)) return value;
    const voDef: ContractValueObject | undefined = domainValueObjectsAtDefaultNamespace(domain)?.[type.name];
    return voDef ? decodeFields(value, voDef.fields, domain) : value;
  }
  // Union fields carry no discriminant at this layer — pass through unchanged.
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
