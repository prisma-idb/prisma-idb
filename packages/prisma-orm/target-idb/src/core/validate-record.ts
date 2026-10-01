import type { CodecLookup } from "@prisma/orm-framework/components/codec";
import type { ContractField, ContractFieldType, ContractWithDomain } from "@prisma/orm-framework/contract/types";
import {
  domainModelsAtDefaultNamespace,
  domainValueObjectsAtDefaultNamespace,
} from "@prisma/orm-framework/contract/types";
import { type, type Type } from "arktype";
import { idbCodecLookup } from "./codecs";
import { isValidIdbKey } from "./key-compare";

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] };

/** Codec application types, not SQL storage types or JSON wire types. */
export type ValidationCodecLookup = Pick<CodecLookup, "targetTypesFor">;

export interface RecordValidationOptions {
  readonly codecLookup?: ValidationCodecLookup;
  /** Updates validate only supplied fields; supplied undefined is still invalid. */
  readonly partial?: boolean;
  /** Create inputs may omit fields filled by the server's defaults. */
  readonly optionalFields?: readonly string[];
}

const scalarTypes: Record<string, Type> = {
  string: type("string"),
  number: type("number").narrow(Number.isFinite),
  boolean: type("boolean"),
  bigint: type("bigint"),
  Date: type.instanceOf(Date).narrow((value) => !Number.isNaN(value.getTime())),
  Uint8Array: type.instanceOf(Uint8Array),
  unknown: type("unknown"),
};

// Contracts and lookup objects are immutable for the lifetime of a runtime.
const validators = new WeakMap<ContractWithDomain, WeakMap<ValidationCodecLookup, Map<string, Type>>>();

function buildType(contract: ContractWithDomain, fieldType: ContractFieldType, lookup: ValidationCodecLookup): Type {
  if (fieldType.kind === "scalar") {
    const names = lookup.targetTypesFor(fieldType.codecId);
    const types = names?.map((name) => scalarTypes[name]);
    if (!types?.length || types.some((validator) => validator === undefined)) {
      throw new Error(`No validator for codec "${fieldType.codecId}"`);
    }
    let validator = types[0]!;
    for (const alternative of types.slice(1)) validator = validator.or(alternative!);
    if (fieldType.codecId === "idb/int32@1") {
      validator = type("-2147483648 <= number.integer <= 2147483647");
    }
    return validator;
  }
  if (fieldType.kind === "valueObject") {
    const fields = domainValueObjectsAtDefaultNamespace(contract.domain)?.[fieldType.name]?.fields;
    if (!fields) throw new Error(`Unknown value object "${fieldType.name}"`);
    return buildShape(contract, fields, lookup);
  }
  const members = fieldType.members.map((member) => buildType(contract, member, lookup));
  if (!members.length) throw new Error("Cannot validate an empty union");
  return members.slice(1).reduce((validator, member) => validator.or(member), members[0]!);
}

function buildField(contract: ContractWithDomain, field: ContractField, lookup: ValidationCodecLookup): Type {
  let validator = buildType(contract, field.type, lookup);
  const ref = field.valueSet;
  if (ref) {
    if (ref.plane !== "domain" || ref.entityKind !== "enum" || ref.spaceId !== undefined) {
      throw new Error(`Unsupported value set "${ref.entityName}"`);
    }
    const values = contract.domain.namespaces[ref.namespaceId]?.enum?.[ref.entityName]?.members.map((m) => m.value);
    if (!values?.length) throw new Error(`Unknown or empty enum "${ref.entityName}"`);
    validator = validator.narrow((value) => values.some((allowed) => Object.is(allowed, value)));
  }
  // Nullable applies to the container. List elements remain non-nullable.
  if (field.many) validator = validator.array();
  if (field.dict) validator = type({ "[string]": validator });
  // JSON null is a scalar value (Prisma JsonNull), independent of database nullability.
  const jsonScalar =
    field.type.kind === "scalar" && ["idb/json@1", "pg/json@1", "pg/jsonb@1"].includes(field.type.codecId);
  if (jsonScalar && !field.many && !field.dict) return validator.narrow((value) => value !== undefined);
  return field.nullable ? validator.or("null") : validator.exclude("null | undefined");
}

function buildShape(
  contract: ContractWithDomain,
  fields: Record<string, ContractField>,
  lookup: ValidationCodecLookup,
  options: RecordValidationOptions = {}
): Type {
  const shape: Record<string, Type | "reject"> = { "+": "reject" };
  for (const [name, field] of Object.entries(fields)) {
    const optional = options.partial || options.optionalFields?.includes(name);
    shape[optional ? `${name}?` : name] = buildField(contract, field, lookup);
  }
  return type(shape);
}

function validate(
  contract: ContractWithDomain,
  cacheKey: string,
  input: unknown,
  options: RecordValidationOptions,
  build: (lookup: ValidationCodecLookup) => Type
): ValidationResult {
  const lookup = options.codecLookup ?? idbCodecLookup;
  let byLookup = validators.get(contract);
  if (!byLookup) validators.set(contract, (byLookup = new WeakMap()));
  let cached = byLookup.get(lookup);
  if (!cached) byLookup.set(lookup, (cached = new Map()));
  try {
    let validator = cached.get(cacheKey);
    if (!validator) {
      validator = build(lookup);
      cached.set(cacheKey, validator);
    }
    const result = validator(input);
    return result instanceof type.errors ? { ok: false, issues: [result.summary] } : { ok: true };
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : "Unable to validate record"] };
  }
}

/** Validates native records without stripping extra fields or mutating the input. */
export function validateRecord(
  contract: ContractWithDomain,
  modelName: string,
  record: unknown,
  options: RecordValidationOptions = {}
): ValidationResult {
  const cacheKey = JSON.stringify(["record", modelName, options.partial ?? false, options.optionalFields ?? []]);
  return validate(contract, cacheKey, record, options, (lookup) => {
    const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
    if (!model) throw new Error(`Unknown model "${modelName}"`);
    return buildShape(contract, model.fields, lookup, options);
  });
}

/** Validates a key-only record, including every member of a compound key. */
export function validateKeyFields(
  contract: ContractWithDomain,
  modelName: string,
  record: unknown,
  keyFields: readonly string[],
  options: Pick<RecordValidationOptions, "codecLookup"> = {}
): ValidationResult {
  return validate(contract, JSON.stringify(["key", modelName, keyFields]), record, options, (lookup) => {
    const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
    if (!model) throw new Error(`Unknown model "${modelName}"`);
    if (!keyFields.length) throw new Error("Key must contain at least one field");
    const fields = Object.fromEntries(
      keyFields.map((name) => {
        const field = model.fields[name];
        if (!field) throw new Error(`Unknown key field "${modelName}.${name}"`);
        return [name, { ...field, nullable: false }];
      })
    );
    return buildShape(contract, fields, lookup);
  });
}

/** Validates an IndexedDB key value against the model's storage.keyPath. */
export function validateKeyPath(contract: ContractWithDomain, modelName: string, key: unknown): ValidationResult {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const keyPath = model?.storage["keyPath"];
  if (!isValidIdbKey(key)) return { ok: false, issues: ["Invalid IndexedDB key"] };
  if (typeof keyPath === "string") return validateKeyFields(contract, modelName, { [keyPath]: key }, [keyPath]);
  if (Array.isArray(keyPath) && keyPath.every((name) => typeof name === "string")) {
    if (!Array.isArray(key) || key.length !== keyPath.length) {
      return { ok: false, issues: ["Compound key must match storage.keyPath length"] };
    }
    return validateKeyFields(
      contract,
      modelName,
      Object.fromEntries(keyPath.map((name, i) => [name, key[i]])),
      keyPath
    );
  }
  return { ok: false, issues: [`Unknown keyPath for model "${modelName}"`] };
}
