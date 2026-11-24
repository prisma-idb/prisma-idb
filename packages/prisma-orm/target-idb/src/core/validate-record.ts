import type {
  ContractField,
  ContractFieldType,
  ContractValueObjectField,
  ContractWithDomain,
} from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace, valueObjectAt } from "@prisma/orm-framework/contract/types";
import { type, type Type } from "arktype";
import { idbCodecLookup } from "./codecs";
import { isDecimalString } from "./decimal-compare";
import { isValidIdbKey } from "./key-compare";

/** The validation verdict, with diagnostic messages when a record or key is rejected. */
export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] };

/** Maps a codec id to its JavaScript application types, not SQL storage types or JSON wire types. */
export interface ValidationCodecLookup {
  targetTypesFor(codecId: string): readonly string[] | undefined;
}

/** Selects native codecs and the fields a create or update input may omit. */
export interface RecordValidationOptions {
  readonly codecLookup?: ValidationCodecLookup;
  /** Updates validate only supplied fields; supplied undefined is still invalid. */
  readonly partial?: boolean;
  /** Create inputs may omit fields filled by the server's defaults. */
  readonly optionalFields?: readonly string[];
}

const scalarTypes: Record<string, Type> = {
  string: type("string"),
  "string[]": type("string[]"),
  number: type("number").narrow(Number.isFinite),
  boolean: type("boolean"),
  bigint: type("bigint"),
  Date: type.instanceOf(Date).narrow((value) => !Number.isNaN(value.getTime())),
  Uint8Array: type.instanceOf(Uint8Array),
  unknown: type("unknown"),
};

// Contracts and lookup objects are immutable for the lifetime of a runtime.
const validators = new WeakMap<ContractWithDomain, WeakMap<ValidationCodecLookup, Map<string, Type>>>();

/**
 * The deepest nesting a Json value may have. `JSON.stringify` and the sync
 * transport recurse too, so a value nested far deeper than this could be stored
 * but not synced. Checking iteratively keeps a hostile value from overflowing
 * the stack here and turns it into a validation issue instead.
 */
const MAX_JSON_DEPTH = 1000;

/**
 * A value JSON can represent: `null`, a string, a boolean, a finite number, or an
 * array or plain object of such values. IndexedDB could store a `Map`, a `Date`
 * or a class instance, but sync and SQL would lose it (a `Map` serializes as `{}`).
 *
 * An object property whose value is `undefined` is allowed, as in Prisma: JSON
 * drops the key. An `undefined` array element is refused, since JSON would
 * turn it into `null` without saying so.
 */
function isJsonValue(root: unknown): boolean {
  const path = new Set<object>();
  // A frame is a container still being walked; `pending` holds its unchecked children.
  const frames: { container: object; pending: unknown[] }[] = [];
  const visit = (value: unknown, inArray: boolean): boolean => {
    if (value === undefined) return !inArray && frames.length > 0;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (path.has(value) || frames.length >= MAX_JSON_DEPTH) return false;
    const proto = Object.getPrototypeOf(value) as unknown;
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
    path.add(value);
    frames.push({ container: value, pending: Array.isArray(value) ? [...value] : Object.values(value) });
    return true;
  };
  if (root === undefined || !visit(root, false)) return false;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.pending.length === 0) {
      path.delete(frame.container);
      frames.pop();
      continue;
    }
    const child = frame.pending.pop();
    if (!visit(child, Array.isArray(frame.container))) return false;
  }
  return true;
}

/** Builds a native validator and rejects unsupported types with their field's owner. */
function buildType(
  contract: ContractWithDomain,
  fieldType: ContractFieldType,
  lookup: ValidationCodecLookup,
  fieldLabel: string
): Type {
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
    if (fieldType.codecId === "idb/decimal@1") {
      validator = type("string").narrow(isDecimalString);
    }
    if (fieldType.codecId === "idb/json@1") {
      validator = validator.narrow((value) => isJsonValue(value));
    }
    return validator;
  }
  if (fieldType.kind === "valueObject") {
    const fields = valueObjectAt(contract.storage, fieldType)?.fields;
    if (!fields) throw new Error(`Unknown value object "${fieldType.entityName}"`);
    return buildShape(contract, fields, lookup, `Value object "${fieldType.entityName}"`);
  }
  throw new Error(`${fieldLabel} uses a union type, which prisma-idb does not support`);
}

/**
 * The values an enum allows. A model field names the domain enum; a value
 * object field, which lives in storage, names the storage value set.
 */
function valueSetValues(
  contract: ContractWithDomain,
  ref: NonNullable<(ContractField | ContractValueObjectField)["valueSet"]>
): readonly unknown[] | undefined {
  if (ref.plane === "domain" && ref.entityKind === "enum") {
    return contract.domain.namespaces[ref.namespaceId]?.enum?.[ref.entityName]?.members.map((m) => m.value);
  }
  if (ref.plane === "storage" && ref.entityKind === "valueSet") {
    const namespace = Object.hasOwn(contract.storage.namespaces, ref.namespaceId)
      ? contract.storage.namespaces[ref.namespaceId]
      : undefined;
    const valueSet: unknown = namespace?.entries?.["valueSet"]?.[ref.entityName];
    const values: unknown = valueSet && typeof valueSet === "object" ? Reflect.get(valueSet, "values") : undefined;
    return Array.isArray(values) ? values : undefined;
  }
  throw new Error(`Unsupported value set "${ref.entityName}"`);
}

/** Builds a field validator, including its container, enum and nullability constraints. */
function buildField(
  contract: ContractWithDomain,
  field: ContractField | ContractValueObjectField,
  lookup: ValidationCodecLookup,
  fieldLabel: string
): Type {
  let validator = buildType(contract, field.type, lookup, fieldLabel);
  const ref = field.valueSet;
  if (ref) {
    if (ref.spaceId !== undefined) throw new Error(`Unsupported value set "${ref.entityName}"`);
    const values = valueSetValues(contract, ref);
    if (!values?.length) throw new Error(`Unknown or empty enum "${ref.entityName}"`);
    validator = validator.narrow((value) => values.some((allowed) => Object.is(allowed, value)));
  }
  // Nullable applies to the container. List elements are nullable only when the field says so.
  if (field.many) {
    const elementNullable = field.many.elementNullable;
    if (elementNullable) validator = validator.or("null");
    // A JSON codec's `unknown` type needs an explicit predicate: excluding a union
    // member cannot narrow unknown and would still accept null list elements.
    validator = validator.narrow((value) => value !== undefined && (elementNullable || value !== null)).array();
  }
  if (field.dict) validator = type({ "[string]": validator });
  // JSON null is a scalar value (Prisma JsonNull), independent of database nullability.
  const jsonScalar =
    field.type.kind === "scalar" && ["idb/json@1", "pg/json@1", "pg/jsonb@1"].includes(field.type.codecId);
  if (jsonScalar && !field.many && !field.dict) return validator.narrow((value) => value !== undefined);
  return field.nullable ? validator.or("null") : validator.exclude("null | undefined");
}

/** Builds a strict shape for a model or value object. */
function buildShape(
  contract: ContractWithDomain,
  fields: Record<string, ContractField | ContractValueObjectField>,
  lookup: ValidationCodecLookup,
  owner: string,
  options: RecordValidationOptions = {}
): Type {
  const shape: Record<string, Type | "reject"> = { "+": "reject" };
  for (const [name, field] of Object.entries(fields)) {
    const optional = options.partial || options.optionalFields?.includes(name);
    shape[optional ? `${name}?` : name] = buildField(contract, field, lookup, `${owner} field "${name}"`);
  }
  return type(shape);
}

/** Reuses validators and converts construction errors into fail-closed validation issues. */
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

/** Throws on unsupported contract validators before a runtime accepts records. */
export function assertRecordValidator(
  contract: ContractWithDomain,
  modelName: string,
  options: RecordValidationOptions = {}
): void {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  if (!model) throw new Error(`Unknown model "${modelName}"`);
  buildShape(contract, model.fields, options.codecLookup ?? idbCodecLookup, `Model "${modelName}"`, options);
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
    return buildShape(contract, model.fields, lookup, `Model "${modelName}"`, options);
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
    return buildShape(contract, fields, lookup, `Model "${modelName}"`);
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
