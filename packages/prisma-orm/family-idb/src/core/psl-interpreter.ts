import type { ContractSourceDiagnostic, ContractSourceDiagnostics } from "@prisma/orm-framework/config/config-types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import type { FieldSymbol, ModelSymbol, SymbolTable } from "@prisma/orm-framework/psl-parser";
import type { IdbKeyPath, IdbReferentialAction, IdbStorage } from "@prisma-idb/target-idb/pack";
import { notOk, ok } from "@prisma/orm-framework/utils/result";
import type { Result } from "@prisma/orm-framework/utils/result";
import type {
  ContractProjection,
  ContractSchema,
  DefaultGenerator,
  FieldDefault,
  IndexDef,
  IssueLocation,
  ModelDef,
  RelationDef,
} from "./contract-builder";
import { buildContract } from "./contract-builder";

export type { ContractProjection } from "./contract-builder";
export {
  SCALAR_TO_CODEC_ID,
  isValidIdbKeyCodec,
  literalValueMatchesCodec,
  warnDroppedRelation,
} from "./contract-builder";

type Span = ContractSourceDiagnostic["span"];

const REFERENTIAL_ACTIONS: Readonly<Record<string, IdbReferentialAction>> = {
  Cascade: "cascade",
  SetNull: "setNull",
  SetDefault: "setDefault",
  Restrict: "restrict",
  NoAction: "noAction",
};

/** PSL default functions, by name and argument, as TS-DSL generators. */
const DEFAULT_FUNCTIONS: Readonly<Record<string, Readonly<Record<string, DefaultGenerator>>>> = {
  now: { "": "now" },
  uuid: { "": "uuid", "4": "uuid", "7": "uuidv7" },
  cuid: { "": "cuid" },
  autoincrement: { "": "autoincrement" },
};

const EXCLUDE = "idb.exclude";

// ── Attribute helpers ─────────────────────────────────────────────────────────

type AttributeArg = { kind: string; name?: string; value: string };
type Attributed = { readonly attributes: readonly { name: string; args: readonly AttributeArg[]; span: Span }[] };

const attribute = (node: Attributed, name: string) => node.attributes.find((a) => a.name === name);
const positional = (args: readonly AttributeArg[]) => args.find((a) => a.kind === "positional")?.value;
const named = (args: readonly AttributeArg[], name: string) =>
  args.find((a) => a.kind === "named" && a.name === name)?.value;

function parseString(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (t === undefined || t.length < 2) return undefined;
  return (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0] ? t.slice(1, -1) : undefined;
}

function parseList(raw: string | undefined): string[] | undefined {
  const t = raw?.trim();
  if (t === undefined || !t.startsWith("[") || !t.endsWith("]")) return undefined;
  return t
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const keyPathOf = (fields: readonly string[]): IdbKeyPath => (fields.length === 1 ? fields[0]! : [...fields]);

function parseEnumValue(parameter: { kind: string; raw?: string }, name: string): string | undefined {
  if (parameter.kind === "bare") return name;
  try {
    const value: unknown = parameter.kind === "value" ? JSON.parse(parameter.raw!) : undefined;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The `@relation` on an FK-side field, parsed but not validated. */
function parseRelation(field: FieldSymbol) {
  const args = attribute(field, "relation")!.args;
  return { local: parseList(named(args, "fields")) ?? [], target: parseList(named(args, "references")) ?? [], args };
}

type KeyResolution = { key: IdbKeyPath; span: Span } | { code: string; message: string; span: Span };

/** A model's key, or the problem with its `@id`/`@@id` declaration. */
function resolveKey(model: ModelSymbol): KeyResolution {
  const m = model.name;
  const modelAttr = attribute(model, "id");
  const idFields = Object.values(model.fields).filter((f) => attribute(f, "id"));
  if (modelAttr) {
    const fields = parseList(positional(modelAttr.args));
    if (!fields?.length) {
      return {
        code: "IDB_INVALID_ID",
        message: `Model "${m}" @@id([…]) is missing a field list.`,
        span: modelAttr.span,
      };
    }
    if (idFields.length === 0) return { key: keyPathOf(fields), span: modelAttr.span };
  }
  if (idFields.length > 1) {
    const names = idFields.map((f) => f.name).join(", ");
    const message = `Model "${m}" declares @id on multiple fields (${names}). For a compound key, use @@id([${names}]).`;
    return { code: "IDB_MULTIPLE_ID_FIELDS", message, span: model.span };
  }
  if (modelAttr) {
    return { code: "IDB_INVALID_ID", message: `Model "${m}" declares both @id and @@id.`, span: model.span };
  }
  if (idFields.length === 1) return { key: idFields[0]!.name, span: model.span };
  const message = `Model "${m}" has no @id field. Add @id to one scalar field, or @@id([...]) for a compound key.`;
  return { code: "IDB_MISSING_ID", message, span: model.span };
}

// ── PSL → TS-DSL ──────────────────────────────────────────────────────────────

/** A PSL-only diagnostic, with what the client projection needs to hide it. */
type PslIssue = {
  readonly diagnostic: ContractSourceDiagnostic;
  /** Hidden in the client projection when any of these models is excluded. */
  readonly models: readonly string[];
  readonly onExcludedField: boolean;
};

/** Translates a PSL schema into the `defineContract` input it means, plus what's needed to report on it. */
function pslToDsl(table: SymbolTable, sourceId: string) {
  const spans = new Map<string, Span>();
  const issues: PslIssue[] = [];
  const report = (code: string, message: string, span: Span | undefined, models: string[] = [], field?: FieldSymbol) =>
    issues.push({
      diagnostic: { code, message, sourceId, ...(span !== undefined ? { span } : {}) },
      models,
      onExcludedField: field !== undefined && attribute(field, EXCLUDE) !== undefined,
    });

  const enums: Record<string, Record<string, string>> = {};
  for (const block of Object.values(table.topLevel.blocks)) {
    if (block.keyword !== "enum") continue;
    spans.set(`enum:${block.name}`, block.span);
    const members: Record<string, string> = {};
    for (const [name, parameter] of Object.entries(block.block.parameters)) {
      const value = parseEnumValue(parameter, name);
      if (value === undefined) {
        report("IDB_ENUM_VALUE_NOT_STRING", `Enum "${block.name}" member "${name}" must be a string.`, parameter.span);
        continue;
      }
      spans.set(`enum:${block.name}.${name}`, parameter.span);
      members[name] = value;
    }
    enums[block.name] = members;
  }

  const namespaces = Object.values(table.topLevel.namespaces);
  for (const ns of namespaces) {
    const message = `IDB does not support \`namespace ${ns.name} { … }\` blocks. Declare all models at the top level.`;
    report("IDB_UNSUPPORTED_NAMESPACE_BLOCK", message, ns.declarations[0]?.span);
  }

  const all = [...Object.values(table.topLevel.models), ...namespaces.flatMap((ns) => Object.values(ns.models))];
  const byName = new Map(all.map((m) => [m.name, m]));
  const keys = new Map(all.map((m) => [m.name, resolveKey(m)]));

  /** The last valid `@relation` in `target` that points at `model`; what a back-relation resolves to. */
  function foreignKey(target: string, model: string) {
    let found: { local: string[]; target: string[] } | undefined;
    for (const f of Object.values(byName.get(target)!.fields)) {
      if (f.list || f.typeName !== model || !attribute(f, "relation")) continue;
      const rel = parseRelation(f);
      if (rel.local.length > 0 && rel.local.length === rel.target.length) found = rel;
    }
    return found;
  }

  /** `@default(...)` as a TS-DSL default, or a diagnostic when PSL syntax has no TS-DSL meaning. */
  function toDefault(raw: string, field: FieldSymbol, span: Span, m: string): FieldDefault | undefined {
    const t = raw.trim();
    const members = Object.hasOwn(enums, field.typeName) ? enums[field.typeName]! : undefined;
    // An enum default names a member; TS-DSL takes the stored value. List defaults go through for the builder to reject.
    if (members !== undefined) {
      if (Object.hasOwn(members, t)) return members[t]!;
      if (field.list) return t;
      const message = `Field "${m}.${field.name}" @default(${t}) does not name a member of enum "${field.typeName}".`;
      report("IDB_INVALID_ENUM_DEFAULT", message, span, [m], field);
      return undefined;
    }
    if (t === "true" || t === "false") return t === "true";
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    const str = parseString(t);
    if (str !== undefined) return str;
    const call = /^([A-Za-z_]\w*)\s*\((.*)\)$/.exec(t);
    const f = `Field "${m}.${field.name}"`;
    if (!call) {
      report("IDB_INVALID_DEFAULT_VALUE", `${f} has unsupported default value "${raw}".`, span, [m], field);
      return undefined;
    }
    const name = call[1]!;
    const arg = call[2]!.trim();
    const generator = Object.hasOwn(DEFAULT_FUNCTIONS, name) ? DEFAULT_FUNCTIONS[name]![arg] : undefined;
    if (generator !== undefined) return { generator };
    if (Object.hasOwn(DEFAULT_FUNCTIONS, name)) {
      const message = `${f} @default(${name}(${arg})) has an unsupported argument.`;
      report("IDB_INVALID_DEFAULT_FUNCTION_ARGUMENT", message, span, [m], field);
    } else {
      const message = `${f} uses unsupported default function "${name}(...)". Supported: now(), uuid(), uuid(7), cuid(), autoincrement().`;
      report("IDB_UNKNOWN_DEFAULT_FUNCTION", message, span, [m], field);
    }
    return undefined;
  }

  const models: Record<string, ModelDef<string>> = {};
  for (const model of all) {
    const m = model.name;
    spans.set(`model:${m}`, model.span);
    const key = keys.get(m)!;
    if (!("key" in key)) {
      report(key.code, key.message, key.span, [m]);
      continue;
    }
    spans.set(`key:${m}`, key.span);

    const indexes: Record<string, IndexDef> = {};
    for (const attr of model.attributes) {
      if (attr.name !== "index" && attr.name !== "unique") continue;
      const fields = parseList(positional(attr.args));
      if (!fields?.length) {
        report("IDB_INVALID_INDEX", `Model "${m}" @@${attr.name} is missing a field list.`, attr.span, [m]);
        continue;
      }
      const unique = attr.name === "unique";
      const explicit = parseString(named(attr.args, "name") ?? named(attr.args, "map"));
      const name = explicit ?? fields.join("_") + (unique ? "_unique" : "");
      indexes[name] = { keyPath: keyPathOf(fields), unique };
      spans.set(`index:${m}.${name}`, attr.span);
    }

    const fields: Record<string, string> = {};
    const fieldDefaults: Record<string, FieldDefault> = {};
    const updatedAt: string[] = [];
    const relations: Record<string, RelationDef> = {};
    for (const field of Object.values(model.fields)) {
      const f = field.name;
      const to = field.typeName;
      spans.set(`field:${m}.${f}`, field.span);

      if (byName.has(to)) {
        spans.set(`relation:${m}.${f}`, field.span);
        if (field.list) {
          // A back-relation into a model with a broken key is skipped; that model is already reported.
          if ("key" in keys.get(to)!) {
            const fk = foreignKey(to, m);
            relations[f] = { to, cardinality: "1:N", on: { local: fk?.target ?? [], target: fk?.local ?? [] } };
          }
          continue;
        }
        if (!attribute(field, "relation")) {
          const message = `Field "${m}.${f}" has model type "${to}" but no @relation(fields: [...], references: [...]).`;
          report("IDB_MISSING_RELATION_ATTRIBUTE", message, field.span, [m]);
          continue;
        }
        const { local, target, args } = parseRelation(field);
        const actions: { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction } = {};
        for (const kind of ["onDelete", "onUpdate"] as const) {
          const raw = named(args, kind)?.trim();
          if (raw === undefined) continue;
          if (Object.hasOwn(REFERENTIAL_ACTIONS, raw)) {
            actions[kind] = REFERENTIAL_ACTIONS[raw]!;
          } else {
            const message = `Relation "${m}.${f}" has unknown ${kind} "${raw}". Valid: ${Object.keys(REFERENTIAL_ACTIONS).join(", ")}.`;
            report("IDB_UNKNOWN_REFERENTIAL_ACTION", message, field.span, [m, to], field);
          }
        }
        relations[f] = {
          to,
          cardinality: "N:1",
          on: { local, target },
          nullable: field.optional,
          ...actions,
          index: true,
        };
        for (const fk of local) if (!spans.has(`index:${m}.${fk}`)) spans.set(`index:${m}.${fk}`, field.span);
        continue;
      }

      const ctor = field.typeConstructor;
      const ctorPath = ctor?.path.join(".");
      if (ctor && (ctorPath !== "temporal.updatedAt" || ctor.args.length > 0)) {
        const [code, message] =
          ctorPath === "temporal.updatedAt"
            ? ["IDB_TEMPORAL_UPDATED_AT_TAKES_NO_ARGS", `Field "${m}.${f}": temporal.updatedAt() takes no arguments.`]
            : [
                "IDB_UNSUPPORTED_TYPE_CONSTRUCTOR",
                `Field "${m}.${f}" uses "${ctorPath}()". IDB supports temporal.updatedAt().`,
              ];
        report(code, message, ctor.span, [m], field);
        continue;
      }

      fields[f] = `${ctor ? "DateTime" : to}${field.list ? "[]" : ""}${field.optional ? "?" : ""}`;
      if (ctor || attribute(field, "updatedAt")) updatedAt.push(f);
      // `temporal.updatedAt()` never reads `@default`.
      const defaultAttr = ctor ? undefined : attribute(field, "default");
      if (defaultAttr) {
        spans.set(`default:${m}.${f}`, defaultAttr.span);
        const raw = positional(defaultAttr.args);
        if (raw === undefined) {
          const message = `Field "${m}.${f}" @default(...) requires an argument.`;
          report("IDB_INVALID_DEFAULT_VALUE", message, defaultAttr.span, [m], field);
        } else {
          const value = toDefault(raw, field, defaultAttr.span, m);
          if (value !== undefined) fieldDefaults[f] = value;
        }
      }

      if (attribute(field, "unique") && !Object.values(indexes).some((idx) => idx.keyPath === f)) {
        indexes[`${f}_unique`] = { keyPath: f, unique: true };
        spans.set(`index:${m}.${f}_unique`, field.span);
      }
    }

    const excludeFields = Object.values(model.fields)
      .filter((f) => attribute(f, EXCLUDE))
      .map((f) => f.name);
    models[m] = {
      store: parseString(positional(attribute(model, "map")?.args ?? [])) ?? m.charAt(0).toLowerCase() + m.slice(1),
      key: key.key,
      fields: fields as ModelDef<string>["fields"],
      indexes,
      relations,
      ...(Object.keys(fieldDefaults).length > 0 ? { fieldDefaults } : {}),
      ...(updatedAt.length > 0 ? { updatedAt } : {}),
      ...(attribute(model, EXCLUDE) ? { exclude: true } : {}),
      ...(excludeFields.length > 0 ? { excludeFields } : {}),
    };
  }

  const excludedModels = new Set(all.filter((m) => attribute(m, EXCLUDE)).map((m) => m.name));
  const schema: ContractSchema = { enums, models };
  return { schema, spans, issues, excludedModels };
}

/** The span an issue points at: the most specific part of its location that has one. */
function spanOf(at: IssueLocation, spans: ReadonlyMap<string, Span>): Span | undefined {
  if (at.enum !== undefined) return spans.get(`enum:${at.enum}.${at.member}`) ?? spans.get(`enum:${at.enum}`);
  const m = at.model;
  const candidates =
    at.attribute === "default"
      ? [`default:${m}.${at.field}`]
      : at.attribute === "key"
        ? [`key:${m}`]
        : [`relation:${m}.${at.relation}`, `field:${m}.${at.field}`, `index:${m}.${at.index}`];
  return [...candidates, `model:${m}`].map((k) => spans.get(k)).find((span) => span !== undefined);
}

// ── Main export ────────────────────────────────────────────────────────────────

export interface InterpretPslOptions {
  /** @default "full" */
  readonly projection?: ContractProjection;
}

/**
 * Interprets a PSL symbol table and produces an IDB `Contract`, by
 * translating it to the `defineContract` input it means and building that.
 *
 * `options.projection: "client"` additionally strips models and fields
 * marked `@@idb.exclude`/`@idb.exclude`. Call this once per projection to
 * emit both the full and the client contract from the same schema.
 */
export function interpretPslDocumentToIdbContract(
  table: SymbolTable,
  sourceId: string,
  options?: InterpretPslOptions
): Result<Contract<IdbStorage>, ContractSourceDiagnostics> {
  const projection: ContractProjection = options?.projection ?? "full";
  const { schema, spans, issues, excludedModels } = pslToDsl(table, sourceId);

  // The client projection never reaches excluded models or fields, so it doesn't report problems inside them.
  const shown =
    projection === "full"
      ? issues
      : issues.filter((i) => !i.onExcludedField && !i.models.some((m) => excludedModels.has(m)));
  const built = buildContract(schema, { projection, validateOnly: shown.length > 0 });

  const diagnostics = shown.map((i) => i.diagnostic);
  for (const issue of built.ok ? [] : built.issues) {
    const span = spanOf(issue.at, spans);
    diagnostics.push({ code: issue.code, message: issue.message, sourceId, ...(span !== undefined ? { span } : {}) });
  }
  if (diagnostics.length > 0 || !built.ok || built.contract === undefined) {
    return notOk({ summary: "PSL to IDB contract interpretation failed", diagnostics });
  }
  return ok(built.contract);
}
