import type { ContractSourceDiagnostic, ContractSourceDiagnostics } from "@prisma/orm-framework/config/config-types";
import { computeExecutionHash, computeProfileHash, computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type {
  ApplicationDomain,
  Contract,
  ContractField,
  ExecutionMutationDefault,
} from "@prisma/orm-framework/contract/types";
import { UNBOUND_DOMAIN_NAMESPACE_ID, crossRef } from "@prisma/orm-framework/contract/types";
import type { FieldSymbol, ModelSymbol, SymbolTable } from "@prisma/orm-framework/psl-parser";
import type {
  IdbIndexDefinition,
  IdbKeyPath,
  IdbModelStorage,
  IdbMutationDefaultGeneratorId,
  IdbReferentialAction,
  IdbStorage,
  IdbStoreDefinition,
} from "@prisma-idb/target-idb/pack";
import { notOk, ok } from "@prisma/orm-framework/utils/result";
import type { Result } from "@prisma/orm-framework/utils/result";
import { validateContract } from "./validate";

/** The one `temporal.*` type-constructor path IDB currently understands. */
const TEMPORAL_UPDATED_AT_PATH = ["temporal", "updatedAt"] as const;

/** Generator id shared by `temporal.updatedAt()`/bare `@updatedAt`/`@default(now())`. */
const TIMESTAMP_NOW_GENERATOR_ID: IdbMutationDefaultGeneratorId = "timestampNow";

/** Synthetic generator id that just echoes `params.value` — backs `@default(<literal>)`. */
const LITERAL_GENERATOR_ID: IdbMutationDefaultGeneratorId = "literal";

/** An execution-plane mutation default resolved for one field, pre-`ref` (the store name isn't known yet at field-resolution time). */
interface FieldExecutionDefault {
  readonly fieldName: string;
  readonly onCreate?: {
    readonly kind: "generator";
    readonly id: IdbMutationDefaultGeneratorId;
    readonly params?: Record<string, unknown>;
  };
  readonly onUpdate?: {
    readonly kind: "generator";
    readonly id: IdbMutationDefaultGeneratorId;
    readonly params?: Record<string, unknown>;
  };
}

/** Parses `@default(...)`'s positional argument as a literal value: `true`/`false`/a number/a quoted string. */
function parseDefaultLiteralValue(raw: string): { readonly value: string | number | boolean } | undefined {
  const t = raw.trim();
  if (t === "true") return { value: true };
  if (t === "false") return { value: false };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t) };
  const str = parseStringArg(t);
  if (str !== undefined) return { value: str };
  return undefined;
}

/**
 * `true` if a parsed `@default(<literal>)` value's JS type matches what
 * `codecId` expects (a literal's JS type must match the field's declared
 * type — a string literal on an Int field, or vice versa, is a mismatch).
 * Declared as a function (not a `codecId → JS type` const lookup) since
 * `SCALAR_TO_CODEC_ID` — which every `codecId` here is sourced from — is
 * declared further down this module; a top-level const initializer would hit
 * the temporal dead zone, but a function body only evaluates when called.
 */
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

/** Parses `@default(...)`'s positional argument as a function call: `name(...)` or bare `name()`. */
function parseDefaultFunctionCall(raw: string): { readonly name: string; readonly arg?: string } | undefined {
  const trimmed = raw.trim();
  const openParen = trimmed.indexOf("(");
  const closeParen = trimmed.lastIndexOf(")");
  if (openParen <= 0 || closeParen !== trimmed.length - 1) return undefined;
  const name = trimmed.slice(0, openParen).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  const arg = trimmed.slice(openParen + 1, closeParen).trim();
  return arg ? { name, arg } : { name };
}

type DefaultFunctionResolution =
  | { readonly ok: true; readonly generatorId: IdbMutationDefaultGeneratorId }
  | { readonly ok: false; readonly reason: "unknown-function" | "invalid-argument" };

/** Resolves a parsed `@default(...)` function call (excluding `autoincrement()`, handled separately as a storage-plane concern) to a generator id. */
function resolveDefaultFunctionGeneratorId(name: string, arg: string | undefined): DefaultFunctionResolution {
  switch (name) {
    case "now":
      return arg === undefined
        ? { ok: true, generatorId: TIMESTAMP_NOW_GENERATOR_ID }
        : { ok: false, reason: "invalid-argument" };
    case "uuid":
      if (arg === undefined || arg === "4") return { ok: true, generatorId: "uuidv4" };
      if (arg === "7") return { ok: true, generatorId: "uuidv7" };
      return { ok: false, reason: "invalid-argument" };
    case "cuid":
      return arg === undefined ? { ok: true, generatorId: "cuid2" } : { ok: false, reason: "invalid-argument" };
    default:
      return { ok: false, reason: "unknown-function" };
  }
}

// ── Scalar type → codec ID mapping ────────────────────────────────────────────

export const SCALAR_TO_CODEC_ID: Record<string, string> = {
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

// ── IDB valid-key codec set ─────────────────────────────────────────────────────

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

// PSL PascalCase referential actions → IDB lowercase
const REFERENTIAL_ACTION_MAP: Record<string, IdbReferentialAction> = {
  Cascade: "cascade",
  SetNull: "setNull",
  SetDefault: "setDefault",
  Restrict: "restrict",
  NoAction: "noAction",
};

// ── Client contract projection (ADR 012) ───────────────────────────────────────

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

/**
 * ADR 013 — shared between this file and `contract-builder.ts` (which
 * already imports {@link ContractProjection} from here) so the message
 * format isn't duplicated. Called whenever a surviving model's relation is
 * dropped because its target is excluded — any cardinality, required or
 * not; the model itself is never excluded as a result, only the relation.
 */
export function warnDroppedRelation(modelName: string, relationName: string, targetModel: string): void {
  console.warn(
    `[prisma-idb] Dropped relation "${modelName}.${relationName}" from the client contract: target model "${targetModel}" is excluded (ADR 013).`
  );
}

// ── Attribute arg helpers ──────────────────────────────────────────────────────

type AttributeArg = { kind: string; name?: string; value: string };

function findPositionalArg(args: readonly AttributeArg[]): string | undefined {
  return args.find((a) => a.kind === "positional")?.value;
}

function findNamedArg(args: readonly AttributeArg[], name: string): string | undefined {
  return (args.find((a) => a.kind === "named" && a.name === name) as AttributeArg | undefined)?.value;
}

function parseStringArg(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return undefined;
}

function parseFieldList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ── Field helpers ──────────────────────────────────────────────────────────────

function hasFieldAttribute(field: FieldSymbol, name: string): boolean {
  return field.attributes.some((a) => a.name === name);
}

function getFieldAttribute(field: FieldSymbol, name: string) {
  return field.attributes.find((a) => a.name === name);
}

function hasModelAttribute(model: ModelSymbol, name: string): boolean {
  return model.attributes.some((a) => a.name === name);
}

const IDB_EXCLUDE_ATTR = "idb.exclude";

// ── Per-model interpretation result ───────────────────────────────────────────

interface InterpretedModel {
  readonly modelName: string;
  readonly storeName: string;
  readonly keyPath: IdbKeyPath;
  readonly indexes: Record<string, IdbIndexDefinition>;
  readonly fields: Record<string, ContractField>;
  readonly relations: Record<
    string,
    {
      readonly to: ReturnType<typeof crossRef>;
      readonly cardinality: "1:1" | "1:N" | "N:1";
      readonly on: { readonly localFields: readonly string[]; readonly targetFields: readonly string[] };
    }
  >;
  readonly relationsStorage: Record<string, { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction }>;
  /** Literal `@default(...)` values, keyed by field name — feeds `IdbModelStorage.fieldDefaults` (`setDefault`). */
  readonly fieldDefaults: Record<string, string | number | boolean>;
  /** FK-side declarations keyed by targetModelName for back-relation resolution. */
  readonly fksByTarget: ReadonlyMap<string, { fieldName: string; localFields: string[]; targetFields: string[] }>;
  /** Execution-plane defaults resolved from `temporal.updatedAt()`, bare `@updatedAt`, and `@default(...)` — feeds `contract.execution.mutations.defaults`. */
  readonly fieldExecutionDefaults: readonly FieldExecutionDefault[];
  /** `true` when `@default(autoincrement())` was declared on this model's `@id` field — feeds `IdbStoreDefinition.autoIncrement`. */
  readonly autoIncrement: boolean;
}

// ── Core interpreter ───────────────────────────────────────────────────────────

function interpretModel(
  model: ModelSymbol,
  modelNames: ReadonlySet<string>,
  sourceId: string,
  diagnostics: ContractSourceDiagnostic[],
  projection: ContractProjection,
  excludedModelNames: ReadonlySet<string>,
  excludedFieldNamesByModel: ReadonlyMap<string, ReadonlySet<string>>
): InterpretedModel | undefined {
  const modelFields = Object.values(model.fields);
  // Fields marked `@idb.exclude`. Empty (no-op) in "full" projection — the
  // attribute only takes effect when projecting the client contract.
  const excludedFieldNames = new Set(
    projection === "client" ? modelFields.filter((f) => hasFieldAttribute(f, IDB_EXCLUDE_ATTR)).map((f) => f.name) : []
  );
  // Derive store name from @@map or lowerFirst(modelName)
  const mapAttr = model.attributes.find((a) => a.name === "map");
  const storeName = parseStringArg(findPositionalArg(mapAttr?.args ?? [])) ?? lowerFirst(model.name);

  // Find the keyPath: @id field-level attribute OR @@id([field, ...]) model-level.
  // `idFieldNames` is always the ordered list of key member fields (length 1
  // for the common single-field case); `keyPath` collapses to a bare string
  // for that common case and stays an array only for a genuine compound key,
  // matching how every other single-field model in this codebase is authored.
  let keyPath: IdbKeyPath | undefined;
  let idFieldNames: string[] | undefined;

  const idModelAttr = model.attributes.find((a) => a.name === "id");
  if (idModelAttr) {
    const fields = parseFieldList(findPositionalArg(idModelAttr.args));
    if (!fields || fields.length === 0) {
      diagnostics.push({
        code: "IDB_INVALID_ID",
        message: `Model "${model.name}" @@id([…]) is missing a field list.`,
        sourceId,
        span: idModelAttr.span,
      });
      return undefined;
    }
    if (new Set(fields).size !== fields.length) {
      diagnostics.push({
        code: "IDB_INVALID_ID",
        message: `Model "${model.name}" @@id([${fields.join(", ")}]) repeats a field name.`,
        sourceId,
        span: idModelAttr.span,
      });
      return undefined;
    }
    idFieldNames = fields;
    keyPath = fields.length === 1 ? fields[0]! : fields;
  }

  const idFields = modelFields.filter((f) => hasFieldAttribute(f, "id"));
  if (idFields.length > 1) {
    diagnostics.push({
      code: "IDB_MULTIPLE_ID_FIELDS",
      message: `Model "${model.name}" declares @id on multiple fields (${idFields.map((f) => f.name).join(", ")}). Only one @id field is allowed — for a compound primary key, use @@id([${idFields.map((f) => f.name).join(", ")}]) instead.`,
      sourceId,
      span: model.span,
    });
    return undefined;
  }
  if (idFields.length === 1) {
    if (keyPath !== undefined) {
      diagnostics.push({
        code: "IDB_INVALID_ID",
        message: `Model "${model.name}" cannot declare both a field-level @id and a model-level @@id.`,
        sourceId,
        span: model.span,
      });
      return undefined;
    }
    idFieldNames = [idFields[0]!.name];
    keyPath = idFields[0]!.name;
  }

  if (keyPath === undefined || idFieldNames === undefined) {
    diagnostics.push({
      code: "IDB_MISSING_ID",
      message: `Model "${model.name}" has no @id field. Add @id to exactly one scalar field, or @@id([...]) for a compound key.`,
      sourceId,
      span: model.span,
    });
    return undefined;
  }

  const excludedKeyField = idFieldNames.find((f) => excludedFieldNames.has(f));
  if (excludedKeyField !== undefined) {
    diagnostics.push({
      code: "IDB_CANNOT_EXCLUDE_KEY_FIELD",
      message: `Field "${model.name}.${excludedKeyField}" is part of the model's primary key and cannot be marked @idb.exclude — the client contract needs a primary key for every included model.`,
      sourceId,
      span: model.span,
    });
    return undefined;
  }

  // ── Build indexes ────────────────────────────────────────────────────────────
  const indexes: Record<string, IdbIndexDefinition> = {};

  // @@index([fields]) / @@unique([fields]) model attribute — `fields` may be
  // a single field or an ordered list for a compound (multi-field) index.
  for (const attr of model.attributes) {
    if (attr.name !== "index" && attr.name !== "unique") continue;
    const isUnique = attr.name === "unique";
    const fieldListRaw = findPositionalArg(attr.args);
    const fields = parseFieldList(fieldListRaw);
    if (!fields || fields.length === 0) {
      diagnostics.push({
        code: "IDB_INVALID_INDEX",
        message: `Model "${model.name}" @@${attr.name} is missing a field list.`,
        sourceId,
        span: attr.span,
      });
      continue;
    }
    if (new Set(fields).size !== fields.length) {
      diagnostics.push({
        code: "IDB_INVALID_INDEX",
        message: `Model "${model.name}" @@${attr.name}([${fields.join(", ")}]) repeats a field name.`,
        sourceId,
        span: attr.span,
      });
      continue;
    }
    const excludedField = fields.find((f) => excludedFieldNames.has(f));
    if (excludedField !== undefined) {
      diagnostics.push({
        code: "IDB_INDEX_ON_EXCLUDED_FIELD",
        message: `Model "${model.name}" @@${attr.name}([${fields.join(", ")}]) references "${excludedField}", which is marked @idb.exclude. Remove the index or the exclusion.`,
        sourceId,
        span: attr.span,
      });
      continue;
    }
    const nameRaw = findNamedArg(attr.args, "name") ?? findNamedArg(attr.args, "map");
    const defaultName = fields.length === 1 ? fields[0]! : fields.join("_");
    const indexName = parseStringArg(nameRaw) ?? (isUnique ? `${defaultName}_unique` : defaultName);
    const keyPath: IdbKeyPath = fields.length === 1 ? fields[0]! : fields;
    indexes[indexName] = { keyPath, unique: isUnique };
  }

  // ── Walk fields ──────────────────────────────────────────────────────────────
  const contractFields: Record<string, ContractField> = {};
  const relations: InterpretedModel["relations"] = {};
  const relationsStorage: Record<string, { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction }> = {};
  const fieldDefaults: Record<string, string | number | boolean> = {};
  const fksByTarget = new Map<string, { fieldName: string; localFields: string[]; targetFields: string[] }>();
  const fieldExecutionDefaults: FieldExecutionDefault[] = [];
  let autoIncrement = false;

  for (const field of modelFields) {
    // Skip the @id field's optional marker — keyPath fields cannot be nullable in IDB
    if (idFieldNames.includes(field.name) && field.optional) {
      diagnostics.push({
        code: "IDB_NULLABLE_ID",
        message: `Field "${model.name}.${field.name}" is marked as @id but is optional (?). The primary key cannot be nullable.`,
        sourceId,
        span: field.span,
      });
    }

    // Relation list field (backrelation) — skip for now, resolved in second pass
    if (field.list && modelNames.has(field.typeName)) {
      if (excludedModelNames.has(field.typeName)) {
        // The model itself is never excluded because of a relation (ADR
        // 013) — just drop this backrelation and keep the model.
        warnDroppedRelation(model.name, field.name, field.typeName);
      }
      continue;
    }

    // FK-side relation field: non-list, type is a model, has @relation
    const relationAttr = getFieldAttribute(field, "relation");
    if (!field.list && modelNames.has(field.typeName) && relationAttr) {
      if (excludedFieldNames.has(field.name)) {
        diagnostics.push({
          code: "IDB_EXCLUDE_ON_RELATION_FIELD_UNSUPPORTED",
          message: `Field "${model.name}.${field.name}" is a relation field and cannot be marked @idb.exclude directly. Exclude the target model with @@idb.exclude to drop the relation, or exclude a plain scalar field.`,
          sourceId,
          span: field.span,
        });
        continue;
      }
      if (excludedModelNames.has(field.typeName)) {
        // Same reasoning as the backrelation case above: drop the relation
        // (required or not), keep the model, keep the FK scalar field (it's
        // processed independently, below, as a plain scalar).
        warnDroppedRelation(model.name, field.name, field.typeName);
        continue;
      }
      const args = relationAttr.args;
      const localFieldsRaw = findNamedArg(args, "fields");
      const targetFieldsRaw = findNamedArg(args, "references");
      const localFields = parseFieldList(localFieldsRaw);
      const targetFields = parseFieldList(targetFieldsRaw);

      if (!localFields || localFields.length === 0 || !targetFields || targetFields.length === 0) {
        diagnostics.push({
          code: "IDB_INVALID_RELATION",
          message: `Relation field "${model.name}.${field.name}" must declare both fields and references in @relation.`,
          sourceId,
          span: field.span,
        });
        continue;
      }
      if (localFields.length !== targetFields.length) {
        diagnostics.push({
          code: "IDB_INVALID_RELATION",
          message: `Relation field "${model.name}.${field.name}" must have the same number of fields and references.`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      const excludedLocalField = localFields.find((f) => excludedFieldNames.has(f));
      if (excludedLocalField !== undefined) {
        diagnostics.push({
          code: "IDB_CANNOT_EXCLUDE_RELATION_FIELD",
          message: `Field "${model.name}.${excludedLocalField}" backs relation "${model.name}.${field.name}" and cannot be excluded independently — field-level FK exclusion isn't supported (ADR 013's cascade only covers whole-model @@idb.exclude). Exclude the whole model instead, or remove the exclusion.`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      const targetExcludedFields = excludedFieldNamesByModel.get(field.typeName);
      const excludedTargetField = targetExcludedFields
        ? targetFields.find((f) => targetExcludedFields.has(f))
        : undefined;
      if (excludedTargetField !== undefined) {
        diagnostics.push({
          code: "IDB_CANNOT_EXCLUDE_RELATION_FIELD",
          message: `Field "${field.typeName}.${excludedTargetField}" is referenced by relation "${model.name}.${field.name}" and cannot be excluded independently — field-level FK exclusion isn't supported (ADR 013's cascade only covers whole-model @@idb.exclude). Exclude the whole model instead, or remove the exclusion.`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      const onDeleteRaw = findNamedArg(args, "onDelete");
      const onDelete = onDeleteRaw ? REFERENTIAL_ACTION_MAP[onDeleteRaw.trim()] : undefined;

      if (onDeleteRaw && onDelete === undefined) {
        diagnostics.push({
          code: "IDB_UNKNOWN_REFERENTIAL_ACTION",
          message: `Relation field "${model.name}.${field.name}" has unknown onDelete value "${onDeleteRaw}". Valid values: ${Object.keys(REFERENTIAL_ACTION_MAP).join(", ")}.`,
          sourceId,
          span: field.span,
        });
      }

      const onUpdateRaw = findNamedArg(args, "onUpdate");
      const onUpdate = onUpdateRaw ? REFERENTIAL_ACTION_MAP[onUpdateRaw.trim()] : undefined;

      if (onUpdateRaw && onUpdate === undefined) {
        diagnostics.push({
          code: "IDB_UNKNOWN_REFERENTIAL_ACTION",
          message: `Relation field "${model.name}.${field.name}" has unknown onUpdate value "${onUpdateRaw}". Valid values: ${Object.keys(REFERENTIAL_ACTION_MAP).join(", ")}.`,
          sourceId,
          span: field.span,
        });
      }

      relations[field.name] = {
        to: crossRef(field.typeName),
        cardinality: "N:1",
        on: { localFields, targetFields },
      };
      if (onDelete !== undefined || onUpdate !== undefined) {
        relationsStorage[field.name] = {
          ...(onDelete !== undefined ? { onDelete } : {}),
          ...(onUpdate !== undefined ? { onUpdate } : {}),
        };
      }
      fksByTarget.set(field.typeName, {
        fieldName: field.name,
        localFields,
        targetFields,
      });

      // Also create a default index on the FK field(s) if not already indexed
      for (const fkField of localFields) {
        if (!(fkField in indexes)) {
          indexes[fkField] = { keyPath: fkField, unique: false };
        }
      }
      continue;
    }

    // Non-model relation field without @relation — not a scalar, skip with error
    if (!field.list && modelNames.has(field.typeName) && !relationAttr) {
      diagnostics.push({
        code: "IDB_MISSING_RELATION_ATTRIBUTE",
        message: `Field "${model.name}.${field.name}" has model type "${field.typeName}" but no @relation attribute. Add @relation(fields: [...], references: [...]).`,
        sourceId,
        span: field.span,
      });
      continue;
    }

    // Skip list fields of non-model types (JSON arrays etc. are handled as Json codec)
    if (field.list) {
      // Only model-type lists are backrelations; non-model lists are not supported in IDB.
      continue;
    }

    // Scalar field
    if (excludedFieldNames.has(field.name)) {
      if (hasFieldAttribute(field, "unique")) {
        diagnostics.push({
          code: "IDB_INDEX_ON_EXCLUDED_FIELD",
          message: `Field "${model.name}.${field.name}" is marked @unique but also @idb.exclude. Remove the @unique attribute or the exclusion.`,
          sourceId,
          span: field.span,
        });
      }
      // Dropped from the client contract. Its type isn't validated here —
      // a server-only field is free to use a type IDB doesn't support at
      // all, since the client interpreter never needs to represent it.
      continue;
    }

    // `temporal.updatedAt()` — a namespaced type-constructor call in the type
    // position (no plain type name), shared framework-level PSL grammar
    // (same construct the SQL family requires in place of the removed bare
    // `@updatedAt` attribute). Must be checked before the plain-scalar
    // lookup below: `field.typeName` for a type-constructor field is just
    // the call's last path segment ("updatedAt"), not a real scalar type.
    if (field.typeConstructor) {
      const path = field.typeConstructor.path;
      const isTemporalUpdatedAt =
        path.length === TEMPORAL_UPDATED_AT_PATH.length && path.every((p, i) => p === TEMPORAL_UPDATED_AT_PATH[i]);

      if (!isTemporalUpdatedAt) {
        diagnostics.push({
          code: "IDB_UNSUPPORTED_TYPE_CONSTRUCTOR",
          message: `Field "${model.name}.${field.name}" uses unsupported type constructor "${path.join(".")}()". IDB currently only supports temporal.updatedAt().`,
          sourceId,
          span: field.typeConstructor.span,
        });
        continue;
      }
      if (field.typeConstructor.args.length > 0) {
        diagnostics.push({
          code: "IDB_TEMPORAL_UPDATED_AT_TAKES_NO_ARGS",
          message: `Field "${model.name}.${field.name}" — temporal.updatedAt() takes no arguments.`,
          sourceId,
          span: field.typeConstructor.span,
        });
        continue;
      }
      if (idFieldNames.includes(field.name)) {
        diagnostics.push({
          code: "IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD",
          message: `Field "${model.name}.${field.name}" is part of the model's primary key and cannot be temporal.updatedAt() — an auto-managed timestamp cannot also be (part of) the primary key.`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      contractFields[field.name] = {
        nullable: field.optional,
        type: { kind: "scalar", codecId: SCALAR_TO_CODEC_ID["DateTime"]! },
      };
      fieldExecutionDefaults.push({
        fieldName: field.name,
        onCreate: { kind: "generator", id: TIMESTAMP_NOW_GENERATOR_ID },
        onUpdate: { kind: "generator", id: TIMESTAMP_NOW_GENERATOR_ID },
      });
      continue;
    }

    const codecId = SCALAR_TO_CODEC_ID[field.typeName];
    if (codecId === undefined) {
      diagnostics.push({
        code: "IDB_UNSUPPORTED_FIELD_TYPE",
        message: `Field "${model.name}.${field.name}" has unsupported type "${field.typeName}". Supported types: ${Object.keys(SCALAR_TO_CODEC_ID).join(", ")}.`,
        sourceId,
        span: field.span,
      });
      continue;
    }

    contractFields[field.name] = {
      nullable: field.optional,
      type: { kind: "scalar", codecId },
    };

    // `@updatedAt` (classic Prisma spelling) — same runtime semantics as
    // `temporal.updatedAt()` above, just a different PSL surface for the
    // same "fires on both create and update" mutation default.
    const updatedAtAttr = getFieldAttribute(field, "updatedAt");
    const defaultAttr = getFieldAttribute(field, "default");

    if (updatedAtAttr && defaultAttr) {
      diagnostics.push({
        code: "IDB_UPDATED_AT_AND_DEFAULT_CONFLICT",
        message: `Field "${model.name}.${field.name}" cannot combine @updatedAt with @default(...).`,
        sourceId,
        span: defaultAttr.span,
      });
      continue;
    }

    if (updatedAtAttr) {
      if (idFieldNames.includes(field.name)) {
        diagnostics.push({
          code: "IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD",
          message: `Field "${model.name}.${field.name}" is part of the model's primary key and cannot be @updatedAt — an auto-managed timestamp cannot also be (part of) the primary key.`,
          sourceId,
          span: field.span,
        });
        continue;
      }
      if (field.optional) {
        diagnostics.push({
          code: "IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD",
          message: `Field "${model.name}.${field.name}" cannot be both optional and @updatedAt — an omitted value would be ambiguous between "generate one" and "store null". Remove "?" or the attribute.`,
          sourceId,
          span: field.span,
        });
        continue;
      }
      if (codecId !== SCALAR_TO_CODEC_ID["DateTime"]) {
        diagnostics.push({
          code: "IDB_UPDATED_AT_NOT_DATETIME",
          message: `Field "${model.name}.${field.name}" is marked @updatedAt but has type "${field.typeName}", not DateTime.`,
          sourceId,
          span: field.span,
        });
        continue;
      }
      fieldExecutionDefaults.push({
        fieldName: field.name,
        onCreate: { kind: "generator", id: TIMESTAMP_NOW_GENERATOR_ID },
        onUpdate: { kind: "generator", id: TIMESTAMP_NOW_GENERATOR_ID },
      });
    } else if (defaultAttr) {
      const raw = findPositionalArg(defaultAttr.args);
      if (raw === undefined) {
        diagnostics.push({
          code: "IDB_INVALID_DEFAULT_VALUE",
          message: `Field "${model.name}.${field.name}" @default(...) requires a positional argument.`,
          sourceId,
          span: defaultAttr.span,
        });
        continue;
      }

      const literal = parseDefaultLiteralValue(raw);
      if (literal) {
        if (!literalValueMatchesCodec(literal.value, codecId)) {
          diagnostics.push({
            code: "IDB_INVALID_DEFAULT_VALUE",
            message: `Field "${model.name}.${field.name}" has type "${field.typeName}" but @default(${raw}) is a ${typeof literal.value} literal.`,
            sourceId,
            span: defaultAttr.span,
          });
          continue;
        }
        fieldExecutionDefaults.push({
          fieldName: field.name,
          onCreate: { kind: "generator", id: LITERAL_GENERATOR_ID, params: { value: literal.value } },
        });
        // Also feeds `IdbModelStorage.fieldDefaults` (setDefault referential
        // action) — only literal defaults land here, never a generator
        // (uuid()/cuid()/now()/autoincrement()), matching Prisma's own rule
        // that `SetDefault` may only target a scalar/literal default.
        fieldDefaults[field.name] = literal.value;
      } else {
        const call = parseDefaultFunctionCall(raw);
        if (!call) {
          diagnostics.push({
            code: "IDB_INVALID_DEFAULT_VALUE",
            message: `Field "${model.name}.${field.name}" has unsupported default value "${raw}".`,
            sourceId,
            span: defaultAttr.span,
          });
          continue;
        }

        if (call.name === "autoincrement") {
          if (!idFieldNames.includes(field.name)) {
            diagnostics.push({
              code: "IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD",
              message: `Field "${model.name}.${field.name}" uses @default(autoincrement()) but is not the model's @id key. IndexedDB only generates keys for the primary key field.`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }
          if (idFieldNames.length > 1) {
            diagnostics.push({
              code: "IDB_AUTOINCREMENT_ON_COMPOUND_KEY",
              message: `Field "${model.name}.${field.name}" uses @default(autoincrement()) but is part of a compound primary key (@@id([${idFieldNames.join(", ")}])). IndexedDB rejects autoIncrement combined with a compound key (InvalidAccessError) — use a single-field @id if you need autoincrement().`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }
          if (codecId !== SCALAR_TO_CODEC_ID["Int"]) {
            diagnostics.push({
              code: "IDB_AUTOINCREMENT_NOT_INT",
              message: `Field "${model.name}.${field.name}" uses @default(autoincrement()) but has type "${field.typeName}", not Int. IndexedDB key generators only produce numbers.`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }
          autoIncrement = true;
          continue;
        }

        if (field.optional) {
          diagnostics.push({
            code: "IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD",
            message: `Field "${model.name}.${field.name}" cannot be both optional and @default(${call.name}(...)) — an omitted value would be ambiguous between "generate one" and "store null". Remove "?" or the default.`,
            sourceId,
            span: defaultAttr.span,
          });
          continue;
        }

        const resolution = resolveDefaultFunctionGeneratorId(call.name, call.arg);
        if (!resolution.ok) {
          diagnostics.push({
            code:
              resolution.reason === "unknown-function"
                ? "IDB_UNKNOWN_DEFAULT_FUNCTION"
                : "IDB_INVALID_DEFAULT_FUNCTION_ARGUMENT",
            message:
              resolution.reason === "unknown-function"
                ? `Field "${model.name}.${field.name}" uses unsupported default function "${call.name}(...)". Supported: now(), uuid(), uuid(7), cuid(), autoincrement().`
                : `Field "${model.name}.${field.name}" — @default(${call.name}(${call.arg ?? ""})) has an unsupported argument.`,
            sourceId,
            span: defaultAttr.span,
          });
          continue;
        }

        fieldExecutionDefaults.push({
          fieldName: field.name,
          onCreate: { kind: "generator", id: resolution.generatorId },
        });
      }
    }

    // @unique field attribute → unique index
    if (hasFieldAttribute(field, "unique")) {
      const existingKey = Object.entries(indexes).find(([, idx]) => idx.keyPath === field.name)?.[0];
      if (!existingKey) {
        indexes[`${field.name}_unique`] = { keyPath: field.name, unique: true };
      }
    }
  }

  // ── Validate key/index field types against IDB's valid-key algorithm ───────
  // Only checked when the field itself resolved a codec — a field that
  // already failed IDB_UNSUPPORTED_FIELD_TYPE above shouldn't also get a
  // second, redundant diagnostic here. Every entry `interpretModel` puts into
  // `contractFields` is `kind: "scalar"` (see the assignment above) — IDB has
  // no value-object fields — so the narrowing here is just satisfying
  // `ContractField.type`'s shared framework union type.
  const scalarCodecOf = (fieldName: string): string | undefined => {
    const type = contractFields[fieldName]?.type;
    return type?.kind === "scalar" ? type.codecId : undefined;
  };

  for (const keyField of idFieldNames) {
    const keyFieldCodec = scalarCodecOf(keyField);
    if (keyFieldCodec === undefined || isValidIdbKeyCodec(keyFieldCodec)) continue;
    diagnostics.push({
      code: "IDB_INVALID_KEY_TYPE",
      message: `Model "${model.name}" @id field "${keyField}" has type "${keyFieldCodec}", which IndexedDB cannot use as a key. Every write would throw (DataError extracting the primary key). Use String, Int, Float, DateTime, Decimal, or Bytes instead.`,
      sourceId,
      span: modelFields.find((f) => f.name === keyField)?.span ?? model.span,
    });
  }

  for (const [indexName, idx] of Object.entries(indexes)) {
    const idxFields = typeof idx.keyPath === "string" ? [idx.keyPath] : idx.keyPath;
    for (const idxField of idxFields) {
      const fieldCodec = scalarCodecOf(idxField);
      if (fieldCodec === undefined || isValidIdbKeyCodec(fieldCodec)) continue;
      diagnostics.push({
        code: "IDB_INVALID_INDEX_KEY_TYPE",
        message: `Model "${model.name}" index "${indexName}" is keyed on "${idxField}" (type "${fieldCodec}"), which IndexedDB cannot use as an index key. Records are silently omitted from the index on write, and any query against it throws at runtime. Use String, Int, Float, DateTime, Decimal, or Bytes instead.`,
        sourceId,
        span: modelFields.find((f) => f.name === idxField)?.span ?? model.span,
      });
    }
  }

  return {
    modelName: model.name,
    storeName,
    keyPath,
    indexes,
    fields: contractFields,
    relations,
    relationsStorage,
    fieldDefaults,
    fksByTarget,
    fieldExecutionDefaults,
    autoIncrement,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Interprets a PSL symbol table (`buildSymbolTable` from `@prisma/orm-toolchain`)
 * and produces an IDB `Contract`.
 *
 * This is the IDB equivalent of `interpretPslDocumentToSqlContract` from the
 * SQL family. It handles IDB-specific constraints:
 *
 * - No namespace blocks (IDB has a single implicit `__unbound__` namespace)
 * - Compound primary keys (`@@id([a, b])`) and compound secondary indexes
 *   (`@@index([a, b])`/`@@unique([a, b])`) lower to an array `keyPath`,
 *   matching native `createObjectStore`/`createIndex` sequence support
 * - Relations are FK-side (`@relation`) + backrelation list fields
 * - Indexes map directly to `IDBObjectStore.createIndex()` calls
 *
 * `options.projection: "client"` additionally strips models/fields marked
 * `@@idb.exclude`/`@idb.exclude`, producing the projected client contract
 * (ADR 012). Call this twice — once per projection — to emit both the full
 * and client `Contract`s from the same schema.
 */
export interface InterpretPslOptions {
  /** @default "full" */
  readonly projection?: ContractProjection;
}

export function interpretPslDocumentToIdbContract(
  table: SymbolTable,
  sourceId: string,
  options?: InterpretPslOptions
): Result<Contract<IdbStorage>, ContractSourceDiagnostics> {
  const projection: ContractProjection = options?.projection ?? "full";
  const diagnostics: ContractSourceDiagnostic[] = [];

  // IDB does not support namespace blocks
  const explicitNamespaces = Object.values(table.topLevel.namespaces);
  for (const ns of explicitNamespaces) {
    diagnostics.push({
      code: "IDB_UNSUPPORTED_NAMESPACE_BLOCK",
      message: `IDB does not support \`namespace ${ns.name} { … }\` blocks. All models must be declared at the top level.`,
      sourceId,
      span: ns.span,
    });
  }

  const allModelsUnprojected = [
    ...Object.values(table.topLevel.models),
    ...explicitNamespaces.flatMap((ns) => Object.values(ns.models)),
  ];
  // Full set, including excluded models — needed so field-type checks below
  // still recognize a reference to an excluded model as "a relation", not an
  // unsupported scalar type.
  const modelNames = new Set(allModelsUnprojected.map((m) => m.name));

  // Models marked `@@idb.exclude`. Empty (no-op) in "full" projection. This
  // is the *only* way a model ends up excluded — relations never add to this
  // set (ADR 013 §"Why we don't cascade on requiredness"); a surviving
  // model's relation into this set is dropped, not cascaded.
  const excludedModelNames = new Set(
    projection === "client"
      ? allModelsUnprojected.filter((m) => hasModelAttribute(m, IDB_EXCLUDE_ATTR)).map((m) => m.name)
      : []
  );

  // The models actually interpreted — excluded models are dropped entirely
  // in "client" projection, never reaching `interpretModel`.
  const allModels =
    projection === "client"
      ? allModelsUnprojected.filter((m) => !excludedModelNames.has(m.name))
      : allModelsUnprojected;

  // Field-level exclusions, keyed by model name, so a relation's `references:`
  // fields can be checked against the *target* model's exclusions (a model
  // may not itself be excluded but still have an excluded field a relation
  // points at).
  const excludedFieldNamesByModel = new Map<string, ReadonlySet<string>>(
    projection === "client"
      ? allModelsUnprojected.map((m) => [
          m.name,
          new Set(
            Object.values(m.fields)
              .filter((f) => hasFieldAttribute(f, IDB_EXCLUDE_ATTR))
              .map((f) => f.name)
          ),
        ])
      : []
  );

  const interpretedByName = new Map<string, InterpretedModel>();

  // First pass: interpret each model individually
  for (const model of allModels) {
    const result = interpretModel(
      model,
      modelNames,
      sourceId,
      diagnostics,
      projection,
      excludedModelNames,
      excludedFieldNamesByModel
    );
    if (result) {
      interpretedByName.set(model.name, result);
    }
  }

  // Second pass: resolve backrelation list fields
  for (const model of allModels) {
    const interp = interpretedByName.get(model.name);
    if (!interp) continue;

    for (const field of Object.values(model.fields)) {
      if (!field.list || !modelNames.has(field.typeName)) continue;
      // Already warned about and dropped by the first pass — don't also
      // report it as an unresolved backrelation.
      if (excludedModelNames.has(field.typeName)) continue;

      const targetInterp = interpretedByName.get(field.typeName);
      if (!targetInterp) continue;

      // Find the FK in the target model that points back to this model
      const fk = targetInterp.fksByTarget.get(model.name);
      if (!fk) {
        diagnostics.push({
          code: "IDB_UNRESOLVED_BACKRELATION",
          message: `Backrelation field "${model.name}.${field.name}" (list of ${field.typeName}) has no matching @relation in "${field.typeName}" pointing to "${model.name}". Add @relation(fields: [...], references: [...]) to the FK field in "${field.typeName}".`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      // The 1:N side: localFields are the PK fields of this model, targetFields are the FK fields in the target
      const mutableInterp = interp as { relations: Record<string, unknown> };
      mutableInterp.relations[field.name] = {
        to: crossRef(field.typeName),
        cardinality: "1:N",
        on: { localFields: fk.targetFields, targetFields: fk.localFields },
      };
    }
  }

  if (diagnostics.length > 0) {
    return notOk({
      summary: "PSL to IDB contract interpretation failed",
      diagnostics,
    });
  }

  // ── Build the contract ────────────────────────────────────────────────────────

  const ns = UNBOUND_DOMAIN_NAMESPACE_ID;
  const stores: Record<string, IdbStoreDefinition> = {};
  const roots: Record<string, ReturnType<typeof crossRef>> = {};
  const domainModels: Record<string, unknown> = {};
  const executionDefaults: ExecutionMutationDefault[] = [];

  for (const [modelName, interp] of interpretedByName) {
    stores[interp.storeName] = {
      keyPath: interp.keyPath,
      ...(interp.autoIncrement ? { autoIncrement: true } : {}),
      ...(Object.keys(interp.indexes).length > 0 ? { indexes: interp.indexes } : {}),
    };

    roots[interp.storeName] = crossRef(modelName);

    for (const fd of interp.fieldExecutionDefaults) {
      executionDefaults.push({
        ref: { namespace: ns, table: interp.storeName, column: fd.fieldName },
        ...(fd.onCreate ? { onCreate: fd.onCreate } : {}),
        ...(fd.onUpdate ? { onUpdate: fd.onUpdate } : {}),
      });
    }

    const modelStorage: IdbModelStorage = {
      storeName: interp.storeName,
      keyPath: interp.keyPath,
      ...(Object.keys(interp.relationsStorage).length > 0 ? { relations: interp.relationsStorage } : {}),
      ...(Object.keys(interp.fieldDefaults).length > 0 ? { fieldDefaults: interp.fieldDefaults } : {}),
    };

    domainModels[modelName] = {
      fields: interp.fields,
      relations: interp.relations,
      storage: modelStorage,
    };
  }

  const storageBlock = {
    stores,
    namespaces: { [ns]: { id: ns, entries: {} } },
  };

  const capabilities = {
    idb: { ddlOnlyInUpgrade: true, transactionalDDL: true },
  };

  const storageHash = computeStorageHash({
    target: "idb",
    targetFamily: "idb",
    storage: storageBlock,
  });

  const profileHash = computeProfileHash({
    target: "idb",
    targetFamily: "idb",
    capabilities,
  });

  const storage: IdbStorage = { ...storageBlock, storageHash };

  const domain = {
    namespaces: { [ns]: { models: domainModels } },
  } as unknown as ApplicationDomain;

  const execution =
    executionDefaults.length > 0
      ? {
          executionHash: computeExecutionHash({
            target: "idb",
            targetFamily: "idb",
            execution: { mutations: { defaults: executionDefaults } },
          }),
          mutations: { defaults: executionDefaults },
        }
      : undefined;

  const contract: Contract<IdbStorage> = {
    target: "idb",
    targetFamily: "idb",
    roots,
    domain,
    storage,
    capabilities,
    extensions: {},
    meta: {},
    profileHash,
    ...(execution ? { execution } : {}),
  };

  validateContract(contract);
  return ok(contract);
}
