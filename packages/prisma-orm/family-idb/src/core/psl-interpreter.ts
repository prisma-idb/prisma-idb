import type { ContractSourceDiagnostic, ContractSourceDiagnostics } from "@prisma/orm-framework/config/config-types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { readWrittenValueIntoCodec } from "@prisma/orm-framework/components/authoring";
import { nodePslSpan } from "@prisma/orm-framework/psl-parser";
import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import type { ModelSymbol, SymbolTable } from "@prisma/orm-framework/psl-parser";
import { StringLiteralExprAst } from "@prisma/orm-framework/psl-parser/syntax";
import type { KeyValuePairAst, PslSources } from "@prisma/orm-framework/psl-parser/syntax";
import type {
  IdbKeyPath,
  IdbMutationDefaultGeneratorId,
  IdbReferentialAction,
  IdbStorage,
} from "@prisma-idb/target-idb/pack";
import { notOk, ok } from "@prisma/orm-framework/utils/result";
import type { Result } from "@prisma/orm-framework/utils/result";
import { buildIdbContractFromDefinition } from "./build-contract-from-definition";
import type {
  IdbContractDefinition,
  IdbEnumNode,
  IdbExecutionDefaultNode,
  IdbFieldNode,
  IdbGeneratorNode,
  IdbIndexNode,
  IdbModelNode,
  IdbRelationNode,
} from "./contract-definition";
import { createIdbAttributeBinder, idbDataTypeSupport } from "./psl-binder";
import { idbGeneratorFunctionRegistry, idbGeneratorNode } from "./generator-functions";
import type { IdbAttributeBinder, IdbDefaultValue } from "./psl-binder";
import { PslDefinitionSourceMap } from "./psl-definition-source-map";
import { SCALAR_TO_CODEC_ID } from "./psl-scalars";
import { validateIdbContractDefinition } from "./validate-definition";

/** The removed Prisma field preset that set a field on create and on update. */
const TEMPORAL_UPDATED_AT_PRESET = "temporal.updatedAt";

/** Generator id of `@default(now())`. */
const TIMESTAMP_NOW_GENERATOR_ID: IdbMutationDefaultGeneratorId = "timestampNow";

/** Generator id for plain literals and codec-backed tagged literals. */
const LITERAL_GENERATOR_ID: IdbMutationDefaultGeneratorId = "literal";

/**
 * The call to write in `@onCreate(...)` for a generator function written in
 * `@default(...)`. Prisma 6 wrote `cuid()` for a CUID2, and Prisma 8 requires its
 * version, so `cuid()` is rewritten as `cuid(2)`; any other call stands as written.
 */
function onCreateRewrite(call: string): string {
  return call.replace(/\s/g, "") === "cuid()" ? "cuid(2)" : call;
}

const DECIMAL_CODEC_ID = "idb/decimal@1";

/** A resolved field default before it is attached to its definition field. */
type FieldExecutionDefault = IdbExecutionDefaultNode & { readonly fieldName: string };

/** The plain literal an `@default(...)` argument spells, or `undefined` for other forms. */
function defaultLiteralValue(form: IdbDefaultValue["form"]): { readonly value: string | number | boolean } | undefined {
  return form.kind === "string" || form.kind === "number" || form.kind === "boolean"
    ? { value: form.value }
    : undefined;
}

/** A supported default generator or the reason its declaration was rejected. */
type DefaultFunctionResolution =
  | { readonly ok: true; readonly generatorId: IdbMutationDefaultGeneratorId }
  | { readonly ok: false; readonly reason: "unknown-function" | "invalid-argument" };

/**
 * Resolves a parsed `@default(...)` function call to a generator id. `now()` is
 * the only one: `autoincrement()` is handled as a storage concern, and generator
 * functions such as uuid() are written in `@onCreate(...)`.
 */
function resolveDefaultFunctionGeneratorId(name: string, arg: string | undefined): DefaultFunctionResolution {
  if (name !== "now") return { ok: false, reason: "unknown-function" };
  return arg === undefined
    ? { ok: true, generatorId: TIMESTAMP_NOW_GENERATOR_ID }
    : { ok: false, reason: "invalid-argument" };
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
    `[prisma-idb] Dropped relation "${modelName}.${relationName}" from the client contract: target model "${targetModel}" is excluded. The relation's scalar fields are kept.`
  );
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Reads the stored string of one enum entry: the member name when the entry
 * has no value, or the decoded string literal. Returns `undefined` for any
 * other value.
 */
function enumEntryValue(entry: KeyValuePairAst, memberName: string): string | undefined {
  const value = entry.value();
  if (value === undefined) return memberName;
  return value instanceof StringLiteralExprAst ? value.value() : undefined;
}

/** Resolve declared string enum values and report invalid or duplicated members. */
function interpretEnums(
  table: SymbolTable,
  sourceId: string,
  sources: PslSources | undefined,
  diagnostics: ContractSourceDiagnostic[],
  sourceMap: PslDefinitionSourceMap
): Record<string, IdbEnumNode> {
  const enums: Record<string, IdbEnumNode> = {};

  for (const block of Object.values(table.defaultNamespace.blocks)) {
    if (block.keyword !== "enum") continue;

    sourceMap.set(["enums", block.name], block.span);
    const members: Array<{ readonly name: string; readonly value: string }> = [];

    for (const entry of block.entries) {
      const memberName = entry.key()?.name();
      if (memberName === undefined) continue;
      // Without the parsed sources, a diagnostic can only point at the whole enum block.
      const span = sources !== undefined ? nodePslSpan(entry.syntax, sources) : block.span;
      sourceMap.set(["enums", block.name, "members", memberName], span);
      const value = enumEntryValue(entry, memberName);

      if (value === undefined) {
        diagnostics.push({
          code: "IDB_ENUM_VALUE_NOT_STRING",
          message: `Enum "${block.name}" member "${memberName}" must be a string value. IDB enums are stored as strings.`,
          sourceId,
          span,
        });
        continue;
      }
      members.push({ name: memberName, value });
    }

    enums[block.name] = { name: block.name, members };
  }

  return enums;
}

// ── Per-model interpretation result ───────────────────────────────────────────

/** A lowered model with mutable relations for the backrelation pass. */
interface InterpretedModel {
  readonly definition: IdbModelNode & { readonly relations: IdbRelationNode[] };
  /** FK-side declarations keyed by target model for backrelation resolution. */
  readonly fksByTarget: ReadonlyMap<string, { fieldName: string; localFields: string[]; targetFields: string[] }>;
}

// ── Core interpreter ───────────────────────────────────────────────────────────

/** Resolve one model into IDB fields, indexes, defaults, and reference relations. */
function interpretModel(
  model: ModelSymbol,
  modelNames: ReadonlySet<string>,
  enums: Readonly<Record<string, IdbEnumNode>>,
  sourceId: string,
  diagnostics: ContractSourceDiagnostic[],
  projection: ContractProjection,
  excludedModelNames: ReadonlySet<string>,
  sourceMap: PslDefinitionSourceMap,
  attributes: IdbAttributeBinder
): InterpretedModel | undefined {
  sourceMap.recordModel(model);
  const modelAttributes = attributes.model(model);
  // The binder already reported why; interpreting past it would only add noise.
  if (modelAttributes.failed) return undefined;
  const modelFields = Object.values(model.fields);
  // Fields marked `@idb.exclude`. Empty (no-op) in "full" projection — the
  // attribute only takes effect when projecting the client contract.
  const excludedFieldNames = new Set(
    projection === "client" ? modelFields.filter((f) => attributes.isFieldExcluded(f)).map((f) => f.name) : []
  );
  // Server-only scalars need no attribute binding beyond exclusion validation.
  // Retain key/index markers so projection cannot hide an invalid exclusion.
  const excludedScalarAttributes = new Map(
    modelFields
      .filter((field) => excludedFieldNames.has(field.name) && !modelNames.has(field.typeName))
      .map((field) => [field, attributes.excludedField(model, field)])
  );
  // Derive store name from @@map or lowerFirst(modelName)
  const mapAttr = modelAttributes.map;
  const storeName = mapAttr?.value.name ?? lowerFirst(model.name);

  // Find the keyPath: @id field-level attribute OR @@id([field, ...]) model-level.
  // `keyPath` collapses to a bare string for the common single-field case and
  // stays an array only for a genuine compound key, matching how every other
  // single-field model in this codebase is authored.
  let keyPath: IdbKeyPath | undefined;

  const idModelAttr = modelAttributes.id;
  if (idModelAttr) {
    const fields = [...idModelAttr.value.fields];
    keyPath = fields.length === 1 ? fields[0]! : fields;
  }

  const idFields = modelFields.filter(
    (f) => (excludedScalarAttributes.get(f) ?? attributes.field(model, f)).id !== undefined
  );
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
    keyPath = idFields[0]!.name;
  }

  keyPath ??= [];
  sourceMap.set(
    ["models", model.name, "key"],
    idModelAttr?.span ??
      (idFields[0]
        ? (excludedScalarAttributes.get(idFields[0]) ?? attributes.field(model, idFields[0])).id!
        : model.span)
  );
  sourceMap.set(["models", model.name, "storeName"], mapAttr?.span ?? model.span);

  // ── Build indexes ────────────────────────────────────────────────────────────
  const indexes: Record<string, Omit<IdbIndexNode, "name">> = {};
  // Foreign-key fields of the relations seen so far. The builder indexes them (it has no opt-out in PSL).
  const foreignKeyFields = new Set<string>();

  // @@index([fields]) / @@unique([fields]) model attribute — `fields` may be
  // a single field or an ordered list for a compound (multi-field) index.
  for (const index of modelAttributes.indexes) {
    const fields = [...index.fields];
    const defaultName = fields.length === 1 ? fields[0]! : fields.join("_");
    const indexName = index.name ?? (index.unique ? `${defaultName}_unique` : defaultName);
    const keyPath: IdbKeyPath = fields.length === 1 ? fields[0]! : fields;
    indexes[indexName] = { keyPath, unique: index.unique };
    sourceMap.set(["models", model.name, "indexes", indexName], index.span);
  }

  // ── Walk fields ──────────────────────────────────────────────────────────────
  const fields: Record<string, IdbFieldNode> = {};
  const relations: Record<string, IdbRelationNode> = {};
  const fieldDefaults: Record<string, string | number | boolean> = {};
  const fksByTarget = new Map<string, { fieldName: string; localFields: string[]; targetFields: string[] }>();
  const fieldExecutionDefaults: FieldExecutionDefault[] = [];
  let autoIncrement = false;
  const autoIncrementFields: string[] = [];

  for (const field of modelFields) {
    const excludedAttributes = excludedScalarAttributes.get(field);
    if (excludedAttributes) {
      if (excludedAttributes.unique) {
        indexes[`${field.name}_unique`] = { keyPath: field.name, unique: true };
        sourceMap.set(["models", model.name, "indexes", `${field.name}_unique`], excludedAttributes.unique);
      }
      // Its type and other attributes belong to the server projection.
      continue;
    }
    const fieldAttributes = attributes.field(model, field);
    if (fieldAttributes.failed) continue;

    // `@updatedAt` is a Prisma 6 attribute that Prisma 8 removed. It is refused on
    // every field, relation fields included, with upstream's hint unless the field
    // already writes `@onUpdate(...)`.
    if (fieldAttributes.updatedAt !== undefined) {
      const message = `Field "${model.name}.${field.name}" uses unsupported attribute "@updatedAt"`;
      diagnostics.push({
        code: "PSL_UNSUPPORTED_FIELD_ATTRIBUTE",
        message:
          fieldAttributes.onUpdate === undefined ? `${message}. Use @onCreate(now()) @onUpdate(now()).` : message,
        sourceId,
        span: fieldAttributes.updatedAt,
      });
      continue;
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
    const relationAttr = fieldAttributes.relation;
    if (!field.list && modelNames.has(field.typeName) && relationAttr) {
      if (excludedModelNames.has(field.typeName)) {
        // Same reasoning as the backrelation case above: drop the relation
        // (required or not), keep the model, keep the FK scalar field (it's
        // processed independently, below, as a plain scalar).
        warnDroppedRelation(model.name, field.name, field.typeName);
        continue;
      }
      const { references, onDelete: onDeleteRaw, onUpdate: onUpdateRaw } = relationAttr.value;
      const localFields = relationAttr.value.fields?.slice();
      const targetFields = references?.slice();

      if (!localFields || !targetFields) {
        diagnostics.push({
          code: "IDB_INVALID_RELATION",
          message: `Relation field "${model.name}.${field.name}" must declare both fields and references in @relation.`,
          sourceId,
          span: field.span,
        });
        continue;
      }
      const onDelete = onDeleteRaw ? REFERENTIAL_ACTION_MAP[onDeleteRaw] : undefined;

      if (onDeleteRaw && onDelete === undefined) {
        diagnostics.push({
          code: "IDB_UNKNOWN_REFERENTIAL_ACTION",
          message: `Relation field "${model.name}.${field.name}" has unknown onDelete value "${onDeleteRaw}". Valid values: ${Object.keys(REFERENTIAL_ACTION_MAP).join(", ")}.`,
          sourceId,
          span: field.span,
        });
      }

      const onUpdate = onUpdateRaw ? REFERENTIAL_ACTION_MAP[onUpdateRaw] : undefined;

      if (onUpdateRaw && onUpdate === undefined) {
        diagnostics.push({
          code: "IDB_UNKNOWN_REFERENTIAL_ACTION",
          message: `Relation field "${model.name}.${field.name}" has unknown onUpdate value "${onUpdateRaw}". Valid values: ${Object.keys(REFERENTIAL_ACTION_MAP).join(", ")}.`,
          sourceId,
          span: field.span,
        });
      }

      relations[field.name] = {
        name: field.name,
        to: field.typeName,
        cardinality: "N:1",
        localFields,
        targetFields,
        // `author User?` is the PSL spelling of an optional to-one relation.
        nullable: field.optional,
        ...(onDelete !== undefined ? { onDelete } : {}),
        ...(onUpdate !== undefined ? { onUpdate } : {}),
      };
      sourceMap.set(["models", model.name, "relations", field.name], relationAttr.span);
      fksByTarget.set(field.typeName, {
        fieldName: field.name,
        localFields,
        targetFields,
      });

      for (const fkField of localFields) {
        if (excludedFieldNames.has(fkField)) continue;
        foreignKeyFields.add(fkField);
        // Points a diagnostic on the builder's foreign-key index at the relation.
        if (!Object.hasOwn(indexes, fkField))
          sourceMap.set(["models", model.name, "indexes", fkField], relationAttr.span);
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

    const enumType = enums[field.typeName];

    // A field typed by a call, such as `temporal.updatedAt()`. IDB has no type
    // constructors. `temporal.updatedAt()` was a Prisma field preset, which Prisma 8
    // removed; it is refused with upstream's rewrite.
    if (field.typeConstructor) {
      const path = field.typeConstructor.path.join(".");
      diagnostics.push(
        path === TEMPORAL_UPDATED_AT_PRESET
          ? {
              code: "PSL_UNRESOLVED_REFERENCE",
              message: `${path}() was a field preset, and Prisma 8 removed field presets. Write DateTime${field.optional ? "?" : ""} @onCreate(now()) @onUpdate(now()).`,
              sourceId,
              span: field.typeConstructor.span,
            }
          : {
              code: "IDB_UNSUPPORTED_TYPE_CONSTRUCTOR",
              message: `Field "${model.name}.${field.name}" uses unsupported type constructor "${path}()". IDB has no type constructors.`,
              sourceId,
              span: field.typeConstructor.span,
            }
      );
      continue;
    }

    const codecId = enumType !== undefined ? SCALAR_TO_CODEC_ID["String"]! : SCALAR_TO_CODEC_ID[field.typeName];
    fields[field.name] = {
      name: field.name,
      nullable: field.optional,
      codecId: codecId ?? "",
      ...(codecId === undefined ? { unsupportedType: field.typeName } : {}),
      list: field.list,
      ...(enumType !== undefined ? { enumName: field.typeName } : {}),
    };

    const defaultAttr = fieldAttributes.default;
    if (defaultAttr) {
      sourceMap.set(["models", model.name, "fields", field.name, "literalDefault"], defaultAttr.span);
      sourceMap.set(["models", model.name, "fields", field.name, "executionDefault"], defaultAttr.span);
    }

    // `@onCreate(fn())` and `@onUpdate(fn())`: a generator function the client
    // runs when a record is created, or on every update. Each resolves through
    // the generator functions bound to the field's codec.
    const generated: { onCreate?: IdbGeneratorNode; onUpdate?: IdbGeneratorNode } = {};
    let generatorFailed = false;
    for (const phase of ["onCreate", "onUpdate"] as const) {
      const attribute = fieldAttributes[phase];
      if (attribute === undefined) continue;
      const call = attribute.value;
      if (field.list) {
        diagnostics.push({
          code: "PSL_LIST_EXECUTION_DEFAULT_UNSUPPORTED",
          message: `Field "${model.name}.${field.name}" is a list and cannot use @${phase}(${call.text}). Lists have no per-element generated values; remove @${phase}(...).`,
          sourceId,
          span: attribute.span,
        });
        generatorFailed = true;
        continue;
      }
      const resolution =
        codecId === undefined || enumType !== undefined
          ? undefined
          : idbGeneratorFunctionRegistry.resolve(
              { name: call.fn, args: call.args },
              { codecId, typeParams: undefined, length: undefined }
            );
      if (resolution?.ok) {
        generated[phase] = idbGeneratorNode(resolution.generator);
        continue;
      }
      diagnostics.push({
        code: "PSL_GENERATOR_NOT_APPLICABLE",
        message:
          resolution?.reason === "refused"
            ? `Field "${model.name}.${field.name}": ${resolution.message}`
            : `Field "${model.name}.${field.name}": ${call.fn}() does not apply to codec "${codecId}".`,
        sourceId,
        span: attribute.span,
      });
      generatorFailed = true;
    }
    if (generatorFailed) continue;
    const generatorAttr = fieldAttributes.onCreate ?? fieldAttributes.onUpdate;
    if (generatorAttr !== undefined && defaultAttr === undefined) {
      sourceMap.set(["models", model.name, "fields", field.name, "executionDefault"], generatorAttr.span);
    }

    if (defaultAttr) {
      const { raw, form } = defaultAttr.value;

      const enumMember = enumType === undefined ? undefined : enumType.members.find((member) => raw === member.name);

      if (form.kind === "list") {
        if (!field.list || raw.replace(/\s/g, "") !== "[]") {
          diagnostics.push({
            code: field.list ? "IDB_LIST_DEFAULT_UNSUPPORTED" : "IDB_INVALID_DEFAULT_VALUE",
            message: field.list
              ? `Field "${model.name}.${field.name}": Only an empty list default ([]) is supported.`
              : `Field "${model.name}.${field.name}": A scalar field cannot have a list default.`,
            sourceId,
            span: defaultAttr.span,
          });
          continue;
        }
        fieldExecutionDefaults.push({
          fieldName: field.name,
          onCreate: { id: LITERAL_GENERATOR_ID, params: { value: [] } },
        });
      } else if (form.kind === "tagged") {
        // The field's codec reads the tagged literal: its data type says which
        // tags it takes, refuses text that names no value, and stores the value
        // in the JSON form the codec reads back on each create.
        const read =
          codecId === undefined || field.list
            ? undefined
            : readWrittenValueIntoCodec({
                support: idbDataTypeSupport,
                codecLookup: idbCodecLookup,
                ref: { codecId },
                written: form.written,
                subject: `Field "${model.name}.${field.name}" default`,
              });
        if (!read?.ok) {
          diagnostics.push({
            code: read?.failure.code ?? "IDB_INVALID_DEFAULT_VALUE",
            message:
              read?.failure.message ?? `Field "${model.name}.${field.name}" cannot have the tagged default "${raw}".`,
            sourceId,
            span: defaultAttr.span,
          });
          continue;
        }
        fieldExecutionDefaults.push({
          fieldName: field.name,
          onCreate: { id: LITERAL_GENERATOR_ID, params: { value: read.value, codecId } },
        });
      } else if (enumType !== undefined) {
        const value = enumMember?.value ?? raw;
        fieldExecutionDefaults.push({
          fieldName: field.name,
          onCreate: { id: LITERAL_GENERATOR_ID, params: { value } },
        });
        fieldDefaults[field.name] = value;
      } else {
        // A Decimal keeps the digits as written; a JS number would round them.
        const literal =
          form.kind === "number" && codecId === DECIMAL_CODEC_ID ? { value: form.text } : defaultLiteralValue(form);
        if (literal) {
          fieldExecutionDefaults.push({
            fieldName: field.name,
            onCreate: { id: LITERAL_GENERATOR_ID, params: { value: literal.value } },
          });
          // Also feeds `IdbModelStorage.fieldDefaults` (setDefault referential
          // action) — only literal defaults land here, never a generator
          // (uuid()/cuid()/now()/autoincrement()), matching Prisma's own rule
          // that `SetDefault` may only target a scalar/literal default.
          fieldDefaults[field.name] = literal.value;
        } else {
          if (form.kind !== "call") {
            diagnostics.push({
              code: "IDB_INVALID_DEFAULT_VALUE",
              message: `Field "${model.name}.${field.name}" has unsupported default value "${raw}".`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }

          if (form.name === "autoincrement") {
            autoIncrementFields.push(field.name);
            autoIncrement = true;
            continue;
          }

          // `@default` takes a value, not a generator: a generator function such
          // as uuid() is written in `@onCreate(...)`, as in upstream's SQL PSL.
          if (form.name !== "now" && idbGeneratorFunctionRegistry.has(form.name)) {
            diagnostics.push({
              code: "PSL_GENERATOR_IN_DEFAULT",
              message: `Field "${model.name}.${field.name}": ${raw} is a value the client generates, and @default sets a database default only. Write @onCreate(${onCreateRewrite(raw)}) instead.`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }

          const callArg = form.args.length > 0 ? form.args.join(", ") : undefined;
          const resolution = resolveDefaultFunctionGeneratorId(form.name, callArg);
          if (!resolution.ok) {
            diagnostics.push({
              code:
                resolution.reason === "unknown-function"
                  ? "IDB_UNKNOWN_DEFAULT_FUNCTION"
                  : "IDB_INVALID_DEFAULT_FUNCTION_ARGUMENT",
              message:
                resolution.reason === "unknown-function"
                  ? `Field "${model.name}.${field.name}" uses unsupported default function "${form.name}(...)". Supported: now(), autoincrement().`
                  : `Field "${model.name}.${field.name}" — @default(${form.name}(${callArg ?? ""})) has an unsupported argument.`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }

          // Checked here, before an `@onCreate(...)` can replace the create value
          // and hide a `now()` the field cannot hold.
          if (codecId !== SCALAR_TO_CODEC_ID["DateTime"] || enumType !== undefined || field.list) {
            diagnostics.push({
              code: "IDB_INVALID_DEFAULT_VALUE",
              message: `Field "${model.name}.${field.name}" uses now(), which requires a DateTime field.`,
              sourceId,
              span: defaultAttr.span,
            });
            continue;
          }

          fieldExecutionDefaults.push({
            fieldName: field.name,
            onCreate: { id: resolution.generatorId },
          });
        }
      }
    }

    if (generated.onCreate !== undefined || generated.onUpdate !== undefined) {
      // A `@default(...)` may already give this field a create value. `@onCreate`
      // replaces it, as a client generator always supplies the value before a SQL
      // database default could; `@onUpdate` joins it.
      const existing = fieldExecutionDefaults.findIndex(({ fieldName }) => fieldName === field.name);
      const merged: FieldExecutionDefault = {
        ...(existing === -1 ? { fieldName: field.name } : fieldExecutionDefaults[existing]!),
        ...(generated.onCreate !== undefined ? { onCreate: generated.onCreate } : {}),
        ...(generated.onUpdate !== undefined ? { onUpdate: generated.onUpdate } : {}),
      };
      if (existing === -1) fieldExecutionDefaults.push(merged);
      else fieldExecutionDefaults[existing] = merged;
    }

    // @unique field attribute → unique index
    if (fieldAttributes.unique) {
      const existingKey = Object.entries(indexes).find(([, idx]) => idx.keyPath === field.name)?.[0];
      if (existingKey && !indexes[existingKey]!.unique)
        indexes[existingKey] = { ...indexes[existingKey]!, unique: true };
      if (!existingKey) {
        // A unique foreign key that follows its `@relation` takes the name the builder's
        // foreign-key index would have, so the store keeps one unique index and the
        // builder adds no plain duplicate. Changing this changes `storageHash`.
        const takesForeignKeyIndexName = foreignKeyFields.has(field.name) && !Object.hasOwn(indexes, field.name);
        const indexName = takesForeignKeyIndexName ? field.name : `${field.name}_unique`;
        indexes[indexName] = { keyPath: field.name, unique: true };
        sourceMap.set(["models", model.name, "indexes", indexName], fieldAttributes.unique);
      }
    }
  }

  const executionDefaults = new Map(fieldExecutionDefaults.map(({ fieldName, ...node }) => [fieldName, node]));
  return {
    definition: {
      modelName: model.name,
      storeName,
      key: keyPath,
      indexes: Object.entries(indexes).map(([name, node]) => ({ name, ...node })),
      fields: Object.values(fields).map((field) => ({
        ...field,
        ...(Object.hasOwn(fieldDefaults, field.name) ? { literalDefault: fieldDefaults[field.name]! } : {}),
        ...(executionDefaults.has(field.name) ? { executionDefault: executionDefaults.get(field.name)! } : {}),
      })),
      relations: Object.values(relations),
      autoIncrement,
      ...(autoIncrementFields.length > 0 ? { autoIncrementFields } : {}),
      ...(projection === "client"
        ? {
            exclusions: {
              fields: [...excludedFieldNames],
              declaredFields: modelFields.map((field) => field.name),
              relationFields: modelFields.filter((field) => modelNames.has(field.typeName)).map((field) => field.name),
            },
          }
        : {}),
    },
    fksByTarget,
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
  /** The parsed sources; with them, enum member diagnostics point at the member instead of the block. */
  readonly sources?: PslSources;
}

/** The lowered definition and source locations used to anchor shared diagnostics. */
export interface LoweredPslDefinition {
  readonly definition: IdbContractDefinition;
  readonly sourceMap: PslDefinitionSourceMap;
}

/** Lower supported PSL declarations and pair backrelations without assembling a contract. */
export function lowerPslDocumentToIdbContractDefinition(
  table: SymbolTable,
  sourceId: string,
  options?: InterpretPslOptions
): Result<LoweredPslDefinition, ContractSourceDiagnostics> {
  const projection: ContractProjection = options?.projection ?? "full";
  const diagnostics: ContractSourceDiagnostic[] = [];
  const sourceMap = new PslDefinitionSourceMap();
  const enums = interpretEnums(table, sourceId, options?.sources, diagnostics, sourceMap);
  const attributes = createIdbAttributeBinder({ table, sourceId, sources: options?.sources, diagnostics });

  // IDB does not support namespace blocks
  const explicitNamespaces = Object.values(table.namespaces).filter((ns) => ns !== table.defaultNamespace);
  for (const ns of explicitNamespaces) {
    // A namespace can be declared more than once; anchor on its first declaration.
    const span = ns.declarations[0]?.span;
    diagnostics.push({
      code: "IDB_UNSUPPORTED_NAMESPACE_BLOCK",
      message: `IDB does not support \`namespace ${ns.name} { … }\` blocks. All models must be declared at the top level.`,
      sourceId,
      ...(span !== undefined ? { span } : {}),
    });
  }

  const allModelsUnprojected = [
    ...Object.values(table.defaultNamespace.models),
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
    projection === "client" ? allModelsUnprojected.filter((m) => attributes.isModelExcluded(m)).map((m) => m.name) : []
  );

  // The models actually interpreted — excluded models are dropped entirely
  // in "client" projection, never reaching `interpretModel`.
  const allModels =
    projection === "client"
      ? allModelsUnprojected.filter((m) => !excludedModelNames.has(m.name))
      : allModelsUnprojected;

  const interpretedByName = new Map<string, InterpretedModel>();

  // First pass: interpret each model individually
  for (const model of allModels) {
    const result = interpretModel(
      model,
      modelNames,
      enums,
      sourceId,
      diagnostics,
      projection,
      excludedModelNames,
      sourceMap,
      attributes
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
        interp.definition.relations.push({
          name: field.name,
          to: field.typeName,
          cardinality: "1:N",
          localFields: [],
          targetFields: [],
          unresolvedBackrelation: true,
        });
        continue;
      }

      // The 1:N side: localFields are the PK fields of this model, targetFields are the FK fields in the target
      interp.definition.relations.push({
        name: field.name,
        to: field.typeName,
        cardinality: "1:N",
        localFields: fk.targetFields,
        targetFields: fk.localFields,
      });
      sourceMap.set(["models", model.name, "relations", field.name], field.span);
    }
  }

  const models = [...interpretedByName.values()].map((model) => model.definition);
  const sharedDiagnostics = validateIdbContractDefinition({ models, enums: Object.values(enums) });
  diagnostics.push(
    ...sharedDiagnostics.map(({ code, message, at }) => {
      const span = sourceMap.resolve(at);
      return { code, message, sourceId, ...(span !== undefined ? { span } : {}) };
    })
  );
  if (diagnostics.length > 0) {
    return notOk({ summary: "PSL to IDB contract interpretation failed", diagnostics });
  }

  // Enum declarations are validated before projection; only referenced enums reach a client contract.
  const keptEnums = Object.values(enums).filter(
    (node) =>
      projection !== "client" || models.some((model) => model.fields.some((field) => field.enumName === node.name))
  );
  return ok({ definition: { models, enums: keptEnums }, sourceMap });
}

/** Interpret PSL through the same definition builder used by the TypeScript DSL. */
export function interpretPslDocumentToIdbContract(
  table: SymbolTable,
  sourceId: string,
  options?: InterpretPslOptions
): Result<Contract<IdbStorage>, ContractSourceDiagnostics> {
  const result = lowerPslDocumentToIdbContractDefinition(table, sourceId, options);
  if (!result.ok) return result;
  return ok(buildIdbContractFromDefinition(result.value.definition));
}
