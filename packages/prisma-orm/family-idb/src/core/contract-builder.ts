import { computeExecutionHash, computeProfileHash, computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type {
  ApplicationDomain,
  Contract,
  ContractField,
  ExecutionMutationDefault,
} from "@prisma/orm-framework/contract/types";
import { UNBOUND_DOMAIN_NAMESPACE_ID, crossRef } from "@prisma/orm-framework/contract/types";
import type {
  IdbKeyPath,
  IdbMutationDefaultGeneratorId,
  IdbReferentialAction,
  IdbStorage,
  IdbStoreDefinition,
} from "@prisma-idb/target-idb/pack";
import { keyPathFields } from "@prisma-idb/target-idb/pack";
import { validateContract } from "./validate";

// ── Field type system ─────────────────────────────────────────────────────────

type PrismaScalarType = "String" | "Int" | "Float" | "Boolean" | "DateTime" | "BigInt" | "Decimal" | "Json" | "Bytes";

type PrismaScalarFieldSpec = PrismaScalarType | `${PrismaScalarType}?`;

/**
 * A field spec string: the Prisma scalar type name, optionally suffixed with
 * `?` to indicate the field is nullable (e.g. `"String"`, `"Int?"`, `"DateTime?"`).
 */
export type FieldSpec<EnumName extends string = never> =
  PrismaScalarFieldSpec | EnumName | `${EnumName}?` | `${EnumName}[]`;

/**
 * A named enum: an ordered list of values, where each value is also its
 * member name, or a map from member name to stored value.
 */
export type EnumDef = readonly string[] | Readonly<Record<string, string>>;

export type EnumDefs = Readonly<Record<string, EnumDef>>;

export const SCALAR_TO_CODEC_ID: Readonly<Record<string, string>> = {
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
const STRING = "idb/string@1";

// ── Input types ───────────────────────────────────────────────────────────────

export type RelationDef = {
  readonly to: string;
  readonly cardinality: "1:1" | "1:N" | "N:1";
  readonly on: {
    readonly local: readonly string[];
    readonly target: readonly string[];
  };
  readonly onDelete?: IdbReferentialAction;
  readonly onUpdate?: IdbReferentialAction;
  /**
   * Whether a to-one (`N:1` / `1:1`) relation can be absent. Defaults to
   * `true` when any `on.local` field is nullable (`"String?"`), `false`
   * otherwise. Ignored for `1:N`.
   */
  readonly nullable?: boolean;
  /**
   * Give each `on.local` field a non-unique index named after the field,
   * unless an index of that name exists. Dropped with the relation when the
   * client projection drops it.
   */
  readonly index?: boolean;
};

export type IndexDef = {
  /** A single field name, or an ordered list of field names for a compound (multi-field) index. */
  readonly keyPath: IdbKeyPath;
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
};

/** A value generated on create: the current time, a UUID (v4 or v7), a CUID2, or the store's key generator. */
export type DefaultGenerator = "now" | "uuid" | "uuidv7" | "cuid" | "autoincrement";

/** A literal default (for an enum field, the stored value), or a generated one. */
export type FieldDefault = string | number | boolean | { readonly generator: DefaultGenerator };

export type ModelDef<EnumName extends string = never> = {
  readonly store: string;
  /** The primary key field, or an ordered list of fields for a compound primary key. */
  readonly key: IdbKeyPath;
  /** All scalar fields on the model. Use `"Type"` for non-nullable, `"Type?"` for nullable. */
  readonly fields: Record<string, FieldSpec<EnumName>>;
  readonly indexes?: Record<string, IndexDef>;
  readonly relations?: Record<string, RelationDef>;
  /**
   * Default values, keyed by field name. Filled in by `create()` when the
   * field is omitted. A literal default also backs the `setDefault`
   * referential action.
   */
  readonly fieldDefaults?: Record<string, FieldDefault>;
  /** DateTime fields set to the current time on create and on every update. */
  readonly updatedAt?: readonly string[];
  /** Server-only model — dropped when `defineContract` runs with `{ projection: "client" }`. See ADR 012. */
  readonly exclude?: boolean;
  /** Server-only fields on an otherwise-synced model — dropped in client projection. See ADR 012. */
  readonly excludeFields?: readonly string[];
};

export type DefineContractInput<TEnums extends EnumDefs = Record<never, never>> = {
  /** Pass the default export of `@prisma-idb/family-idb/pack`. */
  readonly family: { readonly familyId: "idb"; readonly id: string };
  /** Pass the default export of `@prisma-idb/target-idb/pack`. */
  readonly target: { readonly targetId: string; readonly id: string };
  readonly enums?: TEnums;
  readonly models: Record<string, ModelDef<Extract<keyof TEnums, string>>>;
};

/**
 * `"full"` builds the schema as-is (the server-facing shape). `"client"`
 * additionally drops excluded models and fields.
 */
export type ContractProjection = "full" | "client";

export type DefineContractOptions = {
  /** @default "full" */
  readonly projection?: ContractProjection;
};

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Codecs outside IndexedDB's valid-key algorithm
 * (https://w3c.github.io/IndexedDB/#key-construct). A key of one of these
 * types throws on every write; an index on one skips records and throws when
 * queried.
 */
const IDB_INVALID_KEY_CODEC_IDS = new Set(["idb/bool@1", "idb/bigint@1", "idb/json@1"]);

export function isValidIdbKeyCodec(codecId: string): boolean {
  return !IDB_INVALID_KEY_CODEC_IDS.has(codecId);
}

const LITERAL_TYPE_BY_CODEC: Readonly<Record<string, string>> = {
  "idb/string@1": "string",
  "idb/int32@1": "number",
  "idb/double@1": "number",
  "idb/decimal@1": "number",
  "idb/bool@1": "boolean",
};

export function literalValueMatchesCodec(value: string | number | boolean, codecId: string): boolean {
  return LITERAL_TYPE_BY_CODEC[codecId] === typeof value;
}

/** Called whenever a surviving model's relation is dropped because its target is excluded. */
export function warnDroppedRelation(modelName: string, relationName: string, targetModel: string): void {
  console.warn(
    `[prisma-idb] Dropped relation "${modelName}.${relationName}" from the client contract: target model "${targetModel}" is excluded. The relation's scalar fields are kept.`
  );
}

const GENERATOR_IDS: Readonly<Record<Exclude<DefaultGenerator, "autoincrement">, IdbMutationDefaultGeneratorId>> = {
  now: "timestampNow",
  uuid: "uuidv4",
  uuidv7: "uuidv7",
  cuid: "cuid2",
};

const has = (record: object, key: string): boolean => Object.hasOwn(record, key);

type ParsedField = { readonly type: string; readonly nullable: boolean; readonly many: boolean };

function parseFieldSpec(spec: string): ParsedField {
  const nullable = spec.endsWith("?");
  const withoutOptional = nullable ? spec.slice(0, -1) : spec;
  const many = withoutOptional.endsWith("[]");
  return { type: many ? withoutOptional.slice(0, -2) : withoutOptional, nullable, many };
}

function enumMembers(def: EnumDef): { name: string; value: string }[] {
  return Array.isArray(def)
    ? def.map((value: string) => ({ name: value, value }))
    : Object.entries(def).map(([name, value]) => ({ name, value }));
}

// ── Issues ────────────────────────────────────────────────────────────────────

/** Where an issue is. The PSL front-end maps this back to a source span. */
export type IssueLocation = {
  readonly enum?: string;
  readonly member?: string;
  readonly model?: string;
  readonly field?: string;
  readonly index?: string;
  readonly relation?: string;
  /** `key` for the primary key declaration, `default` for a field's default. */
  readonly attribute?: "key" | "default";
};

export type ContractIssue = { readonly code: string; readonly message: string; readonly at: IssueLocation };

type Details = Partial<
  Record<"value" | "field" | "target" | "detail" | "type" | "what" | "codec" | "inverse" | "kind", string>
>;

const VALID_KEY_TYPES = "Use String, Int, Float, DateTime, Decimal, or Bytes instead.";
const AMBIGUOUS = `An omitted value would be ambiguous between "generate one" and "store null".`;
const WHOLE_MODEL = "Exclude the whole target model instead, or remove the exclusion.";

/** Message text after the location prefix, by code. */
const MESSAGES = {
  IDB_ENUM_NAME_CONFLICTS_WITH_SCALAR: () => "conflicts with the built-in scalar type of the same name.",
  IDB_ENUM_DUPLICATE_VALUE: (p) => `repeats a value ("${p.value}"). Enum values must be unique.`,
  IDB_ENUM_EMPTY: () => "must declare at least one value.",
  IDB_CANNOT_EXCLUDE_KEY_FIELD: (p) =>
    `excludes its own key field "${p.field}". The client contract needs a primary key for every included model.`,
  IDB_EXCLUDE_ON_RELATION_FIELD_UNSUPPORTED: () =>
    "is excluded. Exclude the target model to drop the relation, or exclude a scalar field.",
  IDB_EXCLUDE_UNKNOWN_FIELD: (p) => `excludes unknown field "${p.field}". It is not declared in "fields".`,
  IDB_UNDECLARED_FIELD: (p) => `${p.what} names field "${p.field}", which is not declared in "fields".`,
  IDB_INDEX_ON_EXCLUDED_FIELD: (p) => `references excluded field "${p.field}". Remove the index or the exclusion.`,
  IDB_CANNOT_EXCLUDE_RELATION_FIELD: (p) =>
    p.target === undefined
      ? `is backed by field "${p.field}", which cannot be excluded independently. ${WHOLE_MODEL}`
      : `references excluded field "${p.target}", which cannot be excluded independently. ${WHOLE_MODEL}`,
  IDB_INVALID_ID: (p) => p.detail!,
  IDB_NULLABLE_ID: () => "is part of the key and is nullable. The primary key cannot be nullable.",
  IDB_UNSUPPORTED_FIELD_TYPE: (p) =>
    `has unsupported type "${p.type}". Supported types: ${Object.keys(SCALAR_TO_CODEC_ID).join(", ")}, or a declared enum.`,
  IDB_LIST_NOT_ENUM: (p) => `is a list of "${p.type}". Only enum fields can be lists.`,
  IDB_OPTIONAL_LIST: () => "is an optional list. A list field cannot be optional.",
  IDB_UPDATED_AT_AND_DEFAULT_CONFLICT: () => "cannot be both updatedAt and have a default.",
  IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD: () =>
    "is part of the primary key and cannot be updatedAt. An auto-managed timestamp cannot be (part of) the key.",
  IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD: (p) => `cannot be both optional and ${p.what}. ${AMBIGUOUS}`,
  IDB_UPDATED_AT_NOT_DATETIME: (p) => `is updatedAt but has type "${p.type}", not DateTime.`,
  IDB_ENUM_LIST_DEFAULT_UNSUPPORTED: () => "is an enum list; list defaults are not supported by IDB.",
  IDB_INVALID_ENUM_DEFAULT: (p) => `default ${p.value} is not a declared value of enum "${p.type}".`,
  IDB_INVALID_DEFAULT_VALUE: (p) =>
    `default is a ${p.value} value, but the field has type "${p.type}". The literal default's JS type must match the field's declared type.`,
  IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD: () =>
    "uses autoincrement() but is not the primary key. IndexedDB only generates keys for the primary key.",
  IDB_AUTOINCREMENT_ON_COMPOUND_KEY: () =>
    "uses autoincrement() but is part of a compound key. IndexedDB rejects autoIncrement with a compound key.",
  IDB_AUTOINCREMENT_NOT_INT: (p) =>
    `uses autoincrement() but has type "${p.type}", not Int. IndexedDB key generators only produce numbers.`,
  IDB_INVALID_KEY_TYPE: (p) =>
    `is a key field of type "${p.codec}", which IndexedDB cannot use as a key. Every write would throw. ${VALID_KEY_TYPES}`,
  IDB_INVALID_INDEX: (p) => p.detail!,
  IDB_INVALID_INDEX_KEY_TYPE: (p) =>
    `is keyed on "${p.field}" (type "${p.codec}"), which IndexedDB cannot use as an index key. Records are silently omitted from the index, and any query against it throws. ${VALID_KEY_TYPES}`,
  IDB_INVALID_RELATION: () => "must have the same, non-zero number of local and target fields.",
  IDB_UNRESOLVED_BACKRELATION: () => "has no matching relation on the target model pointing back to this model.",
  IDB_CONFLICTING_RELATION_ACTION: (p) =>
    `and its reciprocal "${p.inverse}" both declare "${p.kind}". Only one side is ever read at runtime; declare it on one side only.`,
} satisfies Record<string, (p: Details) => string>;

function describe(at: IssueLocation): string {
  if (at.enum !== undefined) return `enum "${at.enum}"`;
  let s = `model "${at.model}"`;
  if (at.relation !== undefined) s += ` relation "${at.relation}"`;
  else if (at.index !== undefined) s += ` index "${at.index}"`;
  else if (at.field !== undefined) s += ` field "${at.field}"`;
  return s;
}

type Report = (code: keyof typeof MESSAGES, at: IssueLocation, p?: Details) => void;

// ── Entry points ──────────────────────────────────────────────────────────────

export type ContractSchema = Omit<DefineContractInput<EnumDefs>, "family" | "target">;

export type BuildResult =
  /** `contract` is absent only with `validateOnly`. */
  | { readonly ok: true; readonly contract?: Contract<IdbStorage> }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

/**
 * Validates a contract definition and builds the contract, collecting every
 * issue. `validateOnly` skips the build, for a caller that already found
 * problems of its own and only wants the rest reported.
 */
export function buildContract(
  input: ContractSchema,
  options?: DefineContractOptions & { readonly validateOnly?: boolean }
): BuildResult {
  const projection = options?.projection ?? "full";
  const enums = input.enums ?? {};
  const issues: ContractIssue[] = [];
  const report: Report = (code, at, p = {}) =>
    issues.push({ code, at, message: `${describe(at)} ${MESSAGES[code](p)}` });

  const usableEnums = validateEnums(enums, report);
  const models = projection === "client" ? projectForClient(input.models, report) : input.models;
  const resolved = new Map<string, ResolvedModel>();
  for (const [name, def] of Object.entries(models)) {
    const model = validateModel(name, withLocalFieldIndexes(def), enums, usableEnums, report);
    if (model) resolved.set(name, model);
  }
  validateRelationActions(models, report);

  if (issues.length > 0) return { ok: false, issues };
  if (options?.validateOnly) return { ok: true };
  return { ok: true, contract: assemble(enums, resolved, projection) };
}

/**
 * Builds a typed IDB contract from a developer-friendly model definition.
 *
 * This is the TypeScript-first (no-emit) authoring path per ADR 006. The
 * returned contract object can be passed directly to `createIdbClient()` or
 * to `typescriptContract()` for config-file usage.
 *
 * @example
 * ```ts
 * import { defineContract } from '@prisma-idb/family-idb/contract-ts';
 * import idbFamily from '@prisma-idb/family-idb/pack';
 * import idbTarget from '@prisma-idb/target-idb/pack';
 *
 * export default defineContract({
 *   family: idbFamily,
 *   target: idbTarget,
 *   models: {
 *     User: {
 *       store: 'users',
 *       key: 'id',
 *       fields: { id: 'String', name: 'String?', email: 'String' },
 *       indexes: { byEmail: { keyPath: 'email', unique: true } },
 *     },
 *   },
 * });
 * ```
 */
export function defineContract<const TEnums extends EnumDefs = Record<never, never>>(
  input: DefineContractInput<TEnums>,
  options?: DefineContractOptions
): Contract<IdbStorage> {
  const result = buildContract(input as ContractSchema, options);
  if (!result.ok) throw new Error(`defineContract: ${result.issues[0]!.message}`);
  return result.contract!;
}

// ── Validation ────────────────────────────────────────────────────────────────

type ModelInput = ModelDef<string>;

/** Returns the enums usable as field types; a field of an unusable enum is already reported through the enum. */
function validateEnums(enums: EnumDefs, report: Report): Set<string> {
  const usable = new Set<string>();
  for (const [name, def] of Object.entries(enums)) {
    if (has(SCALAR_TO_CODEC_ID, name)) report("IDB_ENUM_NAME_CONFLICTS_WITH_SCALAR", { enum: name });
    const seen = new Set<string>();
    for (const { name: member, value } of enumMembers(def)) {
      if (seen.has(value)) report("IDB_ENUM_DUPLICATE_VALUE", { enum: name, member }, { value });
      seen.add(value);
    }
    if (seen.size === 0) report("IDB_ENUM_EMPTY", { enum: name });
    else usable.add(name);
  }
  return usable;
}

/**
 * Drops excluded models and fields. A surviving relation to an excluded
 * model is dropped with a warning, keeping its FK fields. Exclusions that
 * would remove a key field or cut through a relation are issues.
 */
function projectForClient(models: Readonly<Record<string, ModelInput>>, report: Report) {
  const excludedModels = new Set(Object.keys(models).filter((name) => models[name]!.exclude === true));
  const result: Record<string, ModelInput> = {};

  for (const [model, def] of Object.entries(models)) {
    if (excludedModels.has(model)) continue;
    const excluded = new Set(def.excludeFields);
    const keyField = keyPathFields(def.key).find((f) => excluded.has(f));
    if (keyField !== undefined) {
      report("IDB_CANNOT_EXCLUDE_KEY_FIELD", { model }, { field: keyField });
      continue;
    }
    let rejected = false;
    const reject: Report = (...args) => {
      rejected = true;
      report(...args);
    };
    for (const name of excluded) {
      if (has(def.relations ?? {}, name))
        reject("IDB_EXCLUDE_ON_RELATION_FIELD_UNSUPPORTED", { model, relation: name });
      else if (!has(def.fields, name)) reject("IDB_EXCLUDE_UNKNOWN_FIELD", { model }, { field: name });
    }
    for (const [index, idx] of Object.entries(def.indexes ?? {})) {
      const field = keyPathFields(idx.keyPath).find((f) => excluded.has(f));
      if (field !== undefined) reject("IDB_INDEX_ON_EXCLUDED_FIELD", { model, index }, { field });
    }
    const relations: Record<string, RelationDef> = {};
    for (const [relation, rel] of Object.entries(def.relations ?? {})) {
      if (excludedModels.has(rel.to)) {
        warnDroppedRelation(model, relation, rel.to);
        continue;
      }
      const field = rel.on.local.find((f) => excluded.has(f));
      if (field !== undefined && !excluded.has(relation)) {
        reject("IDB_CANNOT_EXCLUDE_RELATION_FIELD", { model, relation }, { field });
      }
      relations[relation] = rel;
    }
    if (rejected) continue;
    const kept = ([name]: [string, unknown]) => !excluded.has(name);
    result[model] = {
      ...def,
      fields: Object.fromEntries(Object.entries(def.fields).filter(kept)),
      fieldDefaults: Object.fromEntries(Object.entries(def.fieldDefaults ?? {}).filter(kept)),
      updatedAt: (def.updatedAt ?? []).filter((f) => !excluded.has(f)),
      relations,
    };
  }

  // A relation may not point at a field the target model excludes.
  for (const [model, def] of Object.entries(result)) {
    for (const [relation, rel] of Object.entries(def.relations ?? {})) {
      const excluded = new Set(models[rel.to]?.excludeFields);
      const field = rel.on.target.find((f) => excluded.has(f));
      if (field !== undefined) {
        report("IDB_CANNOT_EXCLUDE_RELATION_FIELD", { model, relation }, { target: `${rel.to}.${field}` });
      }
    }
  }
  return result;
}

/** Relations with `index: true` get a non-unique index per local field, unless an index of that name exists. */
function withLocalFieldIndexes(def: ModelInput): ModelInput {
  const fields = Object.values(def.relations ?? {}).flatMap((rel) =>
    rel.index && rel.on.local.length === rel.on.target.length ? rel.on.local : []
  );
  const missing = fields.filter((f) => !has(def.indexes ?? {}, f));
  if (missing.length === 0) return def;
  return { ...def, indexes: { ...def.indexes, ...Object.fromEntries(missing.map((f) => [f, { keyPath: f }])) } };
}

type ResolvedField = ParsedField & { readonly codecId: string; readonly enumName?: string };
type ResolvedModel = {
  readonly def: ModelInput;
  readonly fields: Map<string, ResolvedField>;
  readonly autoIncrement: boolean;
};

/** An issue with a field list (empty, repeated, undeclared), or `undefined`. */
function fieldListProblem(what: string, fields: readonly string[], declared: object): string | undefined {
  if (fields.length === 0) return `${what} must name at least one field.`;
  if (new Set(fields).size !== fields.length) return `${what} [${fields.join(", ")}] repeats a field name.`;
  const undeclared = fields.find((f) => !has(declared, f));
  return undeclared === undefined ? undefined : `${what} field "${undeclared}" is not declared in "fields".`;
}

function validateModel(
  model: string,
  def: ModelInput,
  enums: EnumDefs,
  usableEnums: ReadonlySet<string>,
  report: Report
): ResolvedModel | undefined {
  const keyFields = keyPathFields(def.key);
  const keyProblem = fieldListProblem("key", keyFields, def.fields);
  if (keyProblem !== undefined) {
    report("IDB_INVALID_ID", { model, attribute: "key" }, { detail: keyProblem });
    return undefined;
  }
  const defaults = def.fieldDefaults ?? {};
  const updatedAt = new Set(def.updatedAt);
  for (const [what, names] of [
    ["fieldDefaults", Object.keys(defaults)],
    ["updatedAt", [...updatedAt]],
  ] as const) {
    for (const field of names) if (!has(def.fields, field)) report("IDB_UNDECLARED_FIELD", { model }, { what, field });
  }

  const fields = new Map<string, ResolvedField>();
  let autoIncrement = false;
  for (const [f, spec] of Object.entries(def.fields)) {
    const field = parseFieldSpec(spec);
    const at = { model, field: f };
    const isKey = keyFields.includes(f);
    if (isKey && field.nullable) report("IDB_NULLABLE_ID", at);

    const isEnum = has(enums, field.type);
    if (isEnum && !usableEnums.has(field.type)) continue;
    const codecId = isEnum ? STRING : has(SCALAR_TO_CODEC_ID, field.type) ? SCALAR_TO_CODEC_ID[field.type]! : undefined;
    if (codecId === undefined) {
      report("IDB_UNSUPPORTED_FIELD_TYPE", at, { type: field.type });
      continue;
    }
    if (field.many && !isEnum) {
      report("IDB_LIST_NOT_ENUM", at, { type: field.type });
      continue;
    }
    if (field.many && field.nullable) {
      report("IDB_OPTIONAL_LIST", at);
      continue;
    }
    fields.set(f, { ...field, codecId, ...(isEnum ? { enumName: field.type } : {}) });

    const dflt = has(defaults, f) ? defaults[f] : undefined;
    const atDefault = { ...at, attribute: "default" } as const;
    if (updatedAt.has(f)) {
      if (dflt !== undefined) report("IDB_UPDATED_AT_AND_DEFAULT_CONFLICT", atDefault);
      else if (isKey) report("IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD", at);
      else if (field.nullable) report("IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD", at, { what: "updatedAt" });
      else if (codecId !== SCALAR_TO_CODEC_ID["DateTime"]) {
        report("IDB_UPDATED_AT_NOT_DATETIME", at, { type: field.type });
      }
    } else if (dflt === undefined) {
      // nothing to check
    } else if (isEnum && field.many) {
      report("IDB_ENUM_LIST_DEFAULT_UNSUPPORTED", atDefault);
    } else if (typeof dflt !== "object") {
      if (!literalValueMatchesCodec(dflt, codecId)) {
        report("IDB_INVALID_DEFAULT_VALUE", atDefault, { value: typeof dflt, type: field.type });
      } else if (isEnum && !enumMembers(enums[field.type]!).some((m) => m.value === dflt)) {
        report("IDB_INVALID_ENUM_DEFAULT", atDefault, { value: String(dflt), type: field.type });
      }
    } else if (dflt.generator === "autoincrement") {
      if (!isKey) report("IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD", atDefault);
      else if (keyFields.length > 1) report("IDB_AUTOINCREMENT_ON_COMPOUND_KEY", atDefault);
      else if (codecId !== SCALAR_TO_CODEC_ID["Int"]) {
        report("IDB_AUTOINCREMENT_NOT_INT", atDefault, { type: field.type });
      } else autoIncrement = true;
    } else if (field.nullable) {
      report("IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD", atDefault, { what: `generated (${dflt.generator})` });
    }
  }

  for (const f of keyFields) {
    const codec = fields.get(f)?.codecId;
    if (codec !== undefined && !isValidIdbKeyCodec(codec)) {
      report("IDB_INVALID_KEY_TYPE", { model, field: f }, { codec });
    }
  }

  for (const [index, idx] of Object.entries(def.indexes ?? {})) {
    const indexFields = keyPathFields(idx.keyPath);
    const problem =
      fieldListProblem("keyPath", indexFields, def.fields) ??
      (idx.multiEntry && indexFields.length > 1
        ? `combines "multiEntry: true" with a compound "keyPath". IndexedDB rejects this combination (InvalidAccessError).`
        : undefined);
    if (problem !== undefined) {
      report("IDB_INVALID_INDEX", { model, index }, { detail: problem });
      continue;
    }
    if (idx.multiEntry) continue;
    for (const field of indexFields) {
      const codec = fields.get(field)?.codecId;
      if (codec !== undefined && !isValidIdbKeyCodec(codec)) {
        report("IDB_INVALID_INDEX_KEY_TYPE", { model, index, field }, { field, codec });
      }
    }
  }

  for (const [relation, { cardinality, on }] of Object.entries(def.relations ?? {})) {
    if (cardinality === "1:N" && on.local.length === 0) report("IDB_UNRESOLVED_BACKRELATION", { model, relation });
    else if (on.local.length === 0 || on.local.length !== on.target.length) {
      report("IDB_INVALID_RELATION", { model, relation });
    }
  }

  return { def, fields, autoIncrement };
}

const sameFields = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((f, i) => f === b[i]);

/** When a relation and its reciprocal both declare an action, only one is ever read at runtime. */
function validateRelationActions(models: Readonly<Record<string, ModelInput>>, report: Report): void {
  for (const [model, def] of Object.entries(models)) {
    for (const [relation, rel] of Object.entries(def.relations ?? {})) {
      for (const [inverse, inv] of Object.entries(models[rel.to]?.relations ?? {})) {
        if (inv.to !== model || !sameFields(inv.on.local, rel.on.target) || !sameFields(inv.on.target, rel.on.local)) {
          continue;
        }
        for (const kind of ["onDelete", "onUpdate"] as const) {
          if (rel[kind] !== undefined && inv[kind] !== undefined) {
            report("IDB_CONFLICTING_RELATION_ACTION", { model, relation }, { inverse: `${rel.to}.${inverse}`, kind });
          }
        }
      }
    }
  }
}

// ── Contract ──────────────────────────────────────────────────────────────────

function assemble(
  enums: EnumDefs,
  resolved: ReadonlyMap<string, ResolvedModel>,
  projection: ContractProjection
): Contract<IdbStorage> {
  const ns = UNBOUND_DOMAIN_NAMESPACE_ID;
  const stores: Record<string, IdbStoreDefinition> = {};
  const roots: Record<string, ReturnType<typeof crossRef>> = {};
  const models: Record<string, unknown> = {};
  const defaults: ExecutionMutationDefault[] = [];
  const usedEnums = new Set<string>();

  for (const [modelName, { def, fields, autoIncrement }] of resolved) {
    const indexes = Object.fromEntries(
      Object.entries(def.indexes ?? {}).map(([name, { keyPath, unique, multiEntry }]) => [
        name,
        { keyPath, unique: unique ?? false, ...(multiEntry !== undefined ? { multiEntry } : {}) },
      ])
    );
    stores[def.store] = {
      keyPath: def.key,
      ...(autoIncrement ? { autoIncrement: true } : {}),
      ...(Object.keys(indexes).length > 0 ? { indexes } : {}),
    };
    roots[def.store] = crossRef(modelName);

    const contractFields: Record<string, ContractField> = {};
    const fieldDefaults: Record<string, string | number | boolean> = {};
    const updatedAt = new Set(def.updatedAt);
    for (const [name, { nullable, many, codecId, enumName }] of fields) {
      if (enumName !== undefined) usedEnums.add(enumName);
      contractFields[name] = {
        nullable,
        type: { kind: "scalar", codecId },
        ...(many ? { many: true } : {}),
        ...(enumName !== undefined
          ? { valueSet: { plane: "domain", entityKind: "enum", namespaceId: ns, entityName: enumName } }
          : {}),
      };
      const ref = { namespace: ns, table: def.store, column: name };
      const dflt = def.fieldDefaults?.[name];
      if (updatedAt.has(name)) {
        const now = { kind: "generator", id: "timestampNow" } as const;
        defaults.push({ ref, onCreate: now, onUpdate: now });
      } else if (typeof dflt === "object") {
        if (dflt.generator !== "autoincrement") {
          defaults.push({ ref, onCreate: { kind: "generator", id: GENERATOR_IDS[dflt.generator] } });
        }
      } else if (dflt !== undefined) {
        defaults.push({ ref, onCreate: { kind: "generator", id: "literal", params: { value: dflt } } });
        fieldDefaults[name] = dflt;
      }
    }

    const relations: Record<string, unknown> = {};
    const relationActions: Record<string, { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction }> = {};
    for (const [name, { to, cardinality, on, nullable, onDelete, onUpdate }] of Object.entries(def.relations ?? {})) {
      relations[name] = {
        to: crossRef(to),
        cardinality,
        on: { localFields: on.local, targetFields: on.target },
        ...(cardinality === "1:N"
          ? {}
          : { nullable: nullable ?? on.local.some((f) => fields.get(f)?.nullable === true) }),
      };
      if (onDelete !== undefined || onUpdate !== undefined) {
        relationActions[name] = { ...(onDelete && { onDelete }), ...(onUpdate && { onUpdate }) };
      }
    }

    models[modelName] = {
      fields: contractFields,
      relations,
      storage: {
        storeName: def.store,
        keyPath: def.key,
        ...(Object.keys(relationActions).length > 0 ? { relations: relationActions } : {}),
        ...(Object.keys(fieldDefaults).length > 0 ? { fieldDefaults } : {}),
      },
    };
  }

  const domainEnums = Object.fromEntries(
    Object.entries(enums)
      .filter(([name]) => projection === "full" || usedEnums.has(name))
      .map(([name, def]) => [
        name,
        {
          codecId: STRING,
          members: enumMembers(def).filter((m, i, all) => all.findIndex((o) => o.value === m.value) === i),
        },
      ])
  );

  const storageBlock = { stores, namespaces: { [ns]: { id: ns, entries: {} } } };
  const capabilities = { idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } };
  const family = { target: "idb", targetFamily: "idb" } as const;
  const execution = { mutations: { defaults } };

  const contract: Contract<IdbStorage> = {
    ...family,
    roots,
    domain: {
      namespaces: { [ns]: { models, ...(Object.keys(domainEnums).length > 0 ? { enum: domainEnums } : {}) } },
    } as unknown as ApplicationDomain,
    storage: { ...storageBlock, storageHash: computeStorageHash({ ...family, storage: storageBlock }) },
    capabilities,
    extensions: {},
    meta: {},
    profileHash: computeProfileHash({ ...family, capabilities }),
    ...(defaults.length > 0
      ? { execution: { executionHash: computeExecutionHash({ ...family, execution }), ...execution } }
      : {}),
  };
  validateContract(contract);
  return contract;
}
