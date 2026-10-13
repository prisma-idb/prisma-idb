import type { ContractField, ContractFieldType, ContractWithDomain } from "@prisma/orm-framework/contract/types";
import {
  domainModelsAtDefaultNamespace,
  domainValueObjectsAtDefaultNamespace,
} from "@prisma/orm-framework/contract/types";
import { buildFieldTypeValidator } from "./validate-record";

/** Fills the nullable fields a stored record lacks with `null`. Returns the record itself when none is missing. */
export type AbsentAsNull = (record: Record<string, unknown>) => Record<string, unknown>;

type NormalizeValue = (value: unknown) => unknown;
const unchanged: NormalizeValue = (value) => value;

// Contracts are immutable for the lifetime of a runtime.
const normalizers = new WeakMap<ContractWithDomain, Map<string, AbsentAsNull>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function buildTypeNormalizer(contract: ContractWithDomain, fieldType: ContractFieldType): NormalizeValue {
  if (fieldType.kind === "scalar") return unchanged;
  if (fieldType.kind === "valueObject") {
    const fields = domainValueObjectsAtDefaultNamespace(contract.domain)?.[fieldType.name]?.fields;
    if (!fields) throw new Error(`Unknown value object "${fieldType.name}"`);
    const normalize = buildShapeNormalizer(contract, fields);
    return (value) => (isRecord(value) ? normalize(value) : value);
  }
  const members = fieldType.members.map((member) => ({
    normalize: buildTypeNormalizer(contract, member),
    validator: buildFieldTypeValidator(contract, member),
  }));
  return (value) => {
    // A value already valid for a member needs no additions from another member.
    if (members.some(({ validator }) => validator.allows(value))) return value;
    for (const { normalize, validator } of members) {
      const candidate = normalize(value);
      if (validator.allows(candidate)) return candidate;
    }
    return value;
  };
}

function buildFieldNormalizer(contract: ContractWithDomain, field: ContractField): NormalizeValue {
  let normalize = buildTypeNormalizer(contract, field.type);
  if (field.many && normalize !== unchanged) {
    const element = normalize;
    normalize = (value) => {
      if (!Array.isArray(value)) return value;
      let filled: unknown[] | undefined;
      value.forEach((item, index) => {
        const read = element(item);
        if (read !== item) (filled ??= [...value])[index] = read;
      });
      return filled ?? value;
    };
  }
  if (field.dict && normalize !== unchanged) {
    const element = normalize;
    normalize = (value) => {
      if (!isRecord(value)) return value;
      let filled: Record<string, unknown> | undefined;
      for (const [key, item] of Object.entries(value)) {
        const read = element(item);
        if (read !== item) (filled ??= { ...value })[key] = read;
      }
      return filled ?? value;
    };
  }
  const container = normalize;
  return field.nullable ? (value) => (value === undefined ? null : container(value)) : container;
}

function buildShapeNormalizer(contract: ContractWithDomain, fields: Record<string, ContractField>): AbsentAsNull {
  const normalizers = Object.entries(fields)
    .map(([name, field]) => ({ name, normalize: buildFieldNormalizer(contract, field) }))
    .filter(({ normalize }) => normalize !== unchanged);
  return (record) => {
    let filled: Record<string, unknown> | undefined;
    for (const { name, normalize } of normalizers) {
      // `hasOwn` keeps a field named like an `Object.prototype` member, such as `toString`, from reading as stored.
      const value = Object.hasOwn(record, name) ? record[name] : undefined;
      const read = normalize(value);
      if (read !== value) (filled ??= { ...record })[name] = read;
    }
    return filled ?? record;
  };
}

/**
 * Reads a stored record as the contract describes it: a nullable field the record lacks is `null`.
 * This applies inside value objects, containers and union members as well as at the model's root.
 * A field added after the record was written is the usual cause. Reading it as `null` means adding
 * a nullable field needs no walk over the stored records, and `validateRecord` stays strict.
 *
 * The normalizer is built once per model and copies only the branches that need additions.
 */
export function absentAsNull(contract: ContractWithDomain, modelName: string): AbsentAsNull {
  let byModel = normalizers.get(contract);
  if (!byModel) {
    byModel = new Map();
    normalizers.set(contract, byModel);
  }
  const cached = byModel.get(modelName);
  if (cached) return cached;

  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  if (!model) throw new Error(`Unknown model "${modelName}"`);
  const normalize = buildShapeNormalizer(contract, model.fields);
  byModel.set(modelName, normalize);
  return normalize;
}
