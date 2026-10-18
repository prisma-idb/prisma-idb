import type { Contract } from "@prisma/orm-framework/contract/types";
import type { IdbKeyPath, IdbReferentialAction, IdbStorage } from "@prisma-idb/target-idb/pack";
import { buildIdbContractFromDefinition } from "./build-contract-from-definition";
import type {
  IdbContractDefinition,
  IdbEnumNode,
  IdbExecutionDefaultNode,
  IdbFieldNode,
  IdbIndexNode,
  IdbModelNode,
  IdbRelationNode,
} from "./contract-definition";
import type { ContractProjection } from "./psl-interpreter";
import { warnDroppedRelation } from "./psl-interpreter";
import { IdbContractError } from "./contract-error";
import type { FieldDefault } from "./field-defaults";
import { validateIdbContractDefinition } from "./validate-definition";

// ── Field type system ─────────────────────────────────────────────────────────

/** Scalar names supported by the TypeScript IDB contract builder. */
type PrismaScalarType = "String" | "Int" | "Float" | "Boolean" | "DateTime" | "BigInt" | "Decimal" | "Json" | "Bytes";

/** A required or nullable scalar field declaration. */
type PrismaScalarFieldSpec = PrismaScalarType | `${PrismaScalarType}?`;

/**
 * A field spec string: the Prisma scalar type name, optionally suffixed with
 * `?` to indicate the field is nullable (e.g. `"String"`, `"Int?"`, `"DateTime?"`).
 */
export type FieldSpec<EnumName extends string = never> =
  PrismaScalarFieldSpec | EnumName | `${EnumName}?` | `${EnumName}[]`;

/** A named enum's ordered string values. Each value is also its member name. */
export type EnumDef = readonly string[];

/** Named string enums available to model field declarations. */
export type EnumDefs = Readonly<Record<string, EnumDef>>;

const SCALAR_TO_CODEC_ID: Record<PrismaScalarType, string> = {
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

// ── Input types ───────────────────────────────────────────────────────────────

/** A reference relation and its storage-level referential actions. */
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
   * Whether the contract indexes this relation's foreign-key fields (`on.local`).
   * Defaults to `true`, because IndexedDB has no joins and a relation read is an
   * index lookup on the foreign key. Set `false` to skip the index. A declared
   * index with the same name and single-field keyPath also replaces it.
   * Ignored for `1:N`.
   */
  readonly index?: boolean;
};

/** The key fields and flags of one secondary index. */
export type IndexDef = {
  /** A single field name, or an ordered list of field names for a compound (multi-field) index. */
  readonly keyPath: IdbKeyPath;
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
};

/** The fields, storage layout, relations, and projection rules of one model. */
export type ModelDef<EnumName extends string = never> = {
  readonly store: string;
  /** The primary key field, or an ordered list of fields for a compound primary key. */
  readonly key: IdbKeyPath;
  /** All scalar fields on the model. Use `"Type"` for non-nullable, `"Type?"` for nullable. */
  readonly fields: Record<string, FieldSpec<EnumName>>;
  readonly indexes?: Record<string, IndexDef>;
  readonly relations?: Record<string, RelationDef>;
  /**
   * Defaults keyed by field name, the TypeScript counterpart of PSL `@default(...)`
   * and `@updatedAt`. A sibling map to `fields`, deliberately not folded into
   * `FieldSpec` (a bare type string) to avoid widening that type.
   *
   * A helper from this package fills the field on `create()`: `now()`, `uuidv4()`,
   * `uuidv7()`, `cuid2()`, or `updatedAt()` (also on `update()`). `autoincrement()`
   * asks IndexedDB's key generator to assign the store's single `Int` key.
   * A literal fills the field on `create()` and also feeds the `setDefault`
   * referential action, like PSL `@default("x")`.
   */
  readonly defaults?: Record<string, FieldDefault | string | number | boolean>;
  /**
   * Literal default values, keyed by field name — feeds only the `setDefault`
   * referential action (a child's FK field is reset to its own declared
   * default when its parent is deleted/updated with `onDelete`/`onUpdate:
   * "setDefault"`). Does NOT fill the field on `create()`; declare a literal in
   * `defaults` for that. Do not list a field in both maps.
   */
  readonly fieldDefaults?: Record<string, string | number | boolean>;
  /** Server-only model — dropped when `defineContract` runs with `{ projection: "client" }`. See ADR 012. */
  readonly exclude?: boolean;
  /** Server-only fields on an otherwise-synced model — dropped in client projection. See ADR 012. */
  readonly excludeFields?: readonly string[];
};

/** Family and target metadata together with the models and enums to build. */
export type DefineContractInput<TEnums extends EnumDefs = Record<never, never>> = {
  /** Pass the default export of `@prisma-idb/family-idb/pack`. */
  readonly family: { readonly familyId: "idb"; readonly id: string };
  /** Pass the default export of `@prisma-idb/target-idb/pack`. */
  readonly target: { readonly targetId: string; readonly id: string };
  readonly enums?: TEnums;
  readonly models: Record<string, ModelDef<Extract<keyof TEnums, string>>>;
};

/** Projection settings for the TypeScript contract builder. */
export type DefineContractOptions = {
  /** @default "full" */
  readonly projection?: ContractProjection;
};

/** Internal source names survive projection so the shared validator can check exclusions. */
type ProjectedModelDef = ModelDef<string> & {
  readonly declaredFields?: readonly string[];
  readonly relationFields?: readonly string[];
};

/**
 * Drops `exclude: true` models and `excludeFields` entries for the client
 * projection (ADR 012). Any relation a survivor still has to an excluded
 * model is dropped too (ADR 013) — for every cardinality, required or not;
 * the model itself is never excluded as a result (see ADR 013 §"Why we
 * don't cascade on requiredness"). The underlying FK scalar field (if any)
 * is kept, orphaned but inert.
 */
function projectModelsForClient(models: Record<string, ModelDef<string>>): Record<string, ProjectedModelDef> {
  const excludedModelNames = new Set(
    Object.entries(models)
      .filter(([, def]) => def.exclude === true)
      .map(([name]) => name)
  );

  const result: Record<string, ProjectedModelDef> = {};

  for (const [modelName, def] of Object.entries(models)) {
    if (excludedModelNames.has(modelName)) continue;

    const excludedFields = new Set(def.excludeFields ?? []);
    const relations: Record<string, RelationDef> = {};
    for (const [relName, rel] of Object.entries(def.relations ?? {})) {
      if (excludedModelNames.has(rel.to)) {
        warnDroppedRelation(modelName, relName, rel.to);
        continue;
      }
      relations[relName] = rel;
    }

    const fields: Record<string, FieldSpec<string>> = {};
    for (const [fieldName, spec] of Object.entries(def.fields)) {
      if (excludedFields.has(fieldName)) continue;
      fields[fieldName] = spec;
    }

    result[modelName] = {
      ...def,
      fields,
      relations,
      declaredFields: Object.keys(def.fields),
      relationFields: Object.keys(def.relations ?? {}),
    };
  }

  return result;
}

// ── Validate key/index field types against IDB's valid-key algorithm ──────────

/** A field type name with its nullability and list shape. */
type ParsedFieldSpec = {
  readonly typeName: string;
  readonly nullable: boolean;
  readonly many: boolean;
};

/** Separate the field type name from nullable and list suffixes. */
function parseFieldSpec(spec: string): ParsedFieldSpec {
  const nullable = spec.endsWith("?");
  const withoutOptional = nullable ? spec.slice(0, -1) : spec;
  const many = withoutOptional.endsWith("[]");
  return {
    typeName: many ? withoutOptional.slice(0, -2) : withoutOptional,
    nullable,
    many,
  };
}

// ── Lowering into the shared contract definition ──────────────────────────────

/**
 * Lower named string enum members and check TS-only input shapes. Runs on
 * the complete enum map, so a client projection still rejects an invalid enum
 * that only excluded models use.
 */
function lowerEnums(enums: EnumDefs): IdbEnumNode[] {
  return Object.entries(enums).map(([name, values]) => {
    // Preserve the existing TS input restriction on inherited object keys.
    if (name in SCALAR_TO_CODEC_ID && !Object.hasOwn(SCALAR_TO_CODEC_ID, name)) {
      throw new Error(`defineContract: enum "${name}" conflicts with the built-in scalar type of the same name.`);
    }
    if (!Array.isArray(values)) new Set(values);
    return { name, members: values.map((value) => ({ name: value, value })) };
  });
}

/**
 * Client projection: drop enums that no remaining field uses, so an enum that
 * only excluded models or fields reference doesn't reach the client contract.
 */
function keepReferencedEnums(enums: readonly IdbEnumNode[], models: Record<string, ModelDef<string>>): IdbEnumNode[] {
  const referenced = new Set(
    Object.values(models).flatMap((def) => Object.values(def.fields).map((spec) => parseFieldSpec(spec).typeName))
  );
  return enums.filter((node) => referenced.has(node.name));
}

/** Translate one field declaration, and its literal default if it has one, into a field node. */
function lowerField(
  name: string,
  spec: FieldSpec<string>,
  enums: EnumDefs,
  literalDefault: string | number | boolean | undefined,
  executionDefault: IdbExecutionDefaultNode | undefined
): IdbFieldNode {
  const { typeName, nullable, many } = parseFieldSpec(spec);
  const isEnum = Object.hasOwn(enums, typeName);
  const codecId = isEnum ? SCALAR_TO_CODEC_ID.String : SCALAR_TO_CODEC_ID[typeName as PrismaScalarType];
  return {
    name,
    codecId: codecId ?? "",
    ...(codecId === undefined ? { unsupportedType: typeName } : {}),
    nullable,
    list: many,
    ...(isEnum ? { enumName: typeName } : {}),
    ...(literalDefault !== undefined ? { literalDefault } : {}),
    ...(executionDefault !== undefined ? { executionDefault } : {}),
  };
}

/** Translate one relation declaration into a relation node, resolving whether a to-one relation is nullable. */
function lowerRelation(name: string, rel: RelationDef, def: ModelDef<string>): IdbRelationNode {
  return {
    name,
    to: rel.to,
    cardinality: rel.cardinality,
    localFields: rel.on.local,
    targetFields: rel.on.target,
    // The emitter rejects a to-one relation without a boolean `nullable`.
    ...(rel.cardinality === "1:N"
      ? {}
      : { nullable: rel.nullable ?? rel.on.local.some((f) => def.fields[f]?.endsWith("?") === true) }),
    ...(rel.onDelete !== undefined ? { onDelete: rel.onDelete } : {}),
    ...(rel.onUpdate !== undefined ? { onUpdate: rel.onUpdate } : {}),
    ...(rel.index !== undefined ? { index: rel.index } : {}),
  };
}

/** Translate one index declaration into an index node. */
function lowerIndex(name: string, idx: IndexDef): IdbIndexNode {
  return {
    name,
    keyPath: idx.keyPath,
    unique: idx.unique ?? false,
    ...(idx.multiEntry !== undefined ? { multiEntry: idx.multiEntry } : {}),
  };
}

/** A `defaults` entry: a helper's result or a literal value. */
type DeclaredDefault = FieldDefault | string | number | boolean;

/** Runtime callers must supply a scalar literal or one of this package's helper shapes. */
function isDeclaredDefault(value: unknown): value is DeclaredDefault {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "object" || value === null) return false;
  const helper = value as FieldDefault;
  if (helper.kind === "autoincrement") return true;
  if (helper.kind !== "execution" || typeof helper.execution !== "object" || helper.execution === null) return false;
  const { onCreate, onUpdate } = helper.execution;
  if (
    typeof onCreate !== "object" ||
    onCreate === null ||
    !["timestampNow", "uuidv4", "uuidv7", "cuid2"].includes(onCreate.id)
  )
    return false;
  return (
    onUpdate === undefined ||
    (onCreate.id === "timestampNow" &&
      typeof onUpdate === "object" &&
      onUpdate !== null &&
      onUpdate.id === "timestampNow")
  );
}

/**
 * Returns an own entry of a defaults map, or `undefined` when there is none.
 * Reads own properties only, so a field named like an `Object.prototype` member
 * (for example `toString`) never picks up an inherited value.
 */
function ownEntry<T>(map: Record<string, T> | undefined, fieldName: string): T | undefined {
  return map && Object.hasOwn(map, fieldName) ? map[fieldName] : undefined;
}

/** `true` for `autoincrement()`, which sets a store property and no field default. */
function isAutoincrement(declared: DeclaredDefault | undefined): boolean {
  return declared !== null && typeof declared === "object" && declared.kind === "autoincrement";
}

/**
 * Lowers one field's declared defaults. A `defaults` literal fills the field on
 * `create()` and feeds `setDefault`, as PSL `@default("x")` does. A `fieldDefaults`
 * literal feeds `setDefault` only.
 */
function lowerFieldDefaults(
  declared: DeclaredDefault | undefined,
  setDefaultLiteral: string | number | boolean | undefined
): { literalDefault?: string | number | boolean; executionDefault?: IdbExecutionDefaultNode } {
  if (declared === undefined || isAutoincrement(declared)) {
    return setDefaultLiteral !== undefined ? { literalDefault: setDefaultLiteral } : {};
  }
  if (typeof declared === "object") {
    return declared.kind === "execution" ? { executionDefault: declared.execution } : {};
  }
  return { literalDefault: declared, executionDefault: { onCreate: { id: "literal", params: { value: declared } } } };
}

/**
 * Rejects invalid default values, entries that name an undeclared field,
 * and fields listed in both maps. Excluded fields stay allowed: a client
 * projection drops them from `fields` but they are still declared.
 */
function checkDeclaredDefaults(modelName: string, def: ProjectedModelDef): void {
  /** Throws an `IDB_INVALID_DEFAULT_VALUE` error located at the named field's default. */
  const fail = (name: string, message: string): never => {
    throw new IdbContractError([
      {
        code: "IDB_INVALID_DEFAULT_VALUE",
        message,
        at: ["models", modelName, "fields", name, "literalDefault"],
      },
    ]);
  };
  for (const [mapName, map] of [
    ["defaults", def.defaults],
    ["fieldDefaults", def.fieldDefaults],
  ] as const) {
    for (const [name, value] of Object.entries(map ?? {})) {
      if (!Object.hasOwn(def.fields, name) && !def.excludeFields?.includes(name)) {
        fail(name, `Model "${modelName}" ${mapName} references field "${name}", which is not declared in "fields".`);
      }
      if (!isDeclaredDefault(value) || (mapName === "fieldDefaults" && typeof value === "object")) {
        fail(
          name,
          `Model "${modelName}" ${mapName} field "${name}" must be a scalar literal${mapName === "defaults" ? " or a recognized default helper result" : ""}.`
        );
      }
    }
  }
  for (const name of Object.keys(def.defaults ?? {})) {
    if (Object.hasOwn(def.fieldDefaults ?? {}, name)) {
      fail(name, `Model "${modelName}" declares a default for field "${name}" in both "defaults" and "fieldDefaults".`);
    }
  }
}

/** Translate one model declaration into a model node. */
function lowerModel(modelName: string, def: ProjectedModelDef, enums: EnumDefs): IdbModelNode {
  checkDeclaredDefaults(modelName, def);
  const autoIncrementFields = Object.keys(def.fields).filter((name) => isAutoincrement(ownEntry(def.defaults, name)));
  return {
    modelName,
    storeName: def.store,
    ...(def.declaredFields
      ? {
          exclusions: {
            fields: def.excludeFields ?? [],
            declaredFields: def.declaredFields,
            relationFields: def.relationFields ?? [],
          },
        }
      : {}),
    key: def.key,
    // Same as PSL: the request is retained so validation can reject a misplaced one.
    autoIncrement: autoIncrementFields.length > 0,
    ...(autoIncrementFields.length > 0 ? { autoIncrementFields } : {}),
    fields: Object.entries(def.fields).map(([name, spec]) => {
      const { literalDefault, executionDefault } = lowerFieldDefaults(
        ownEntry(def.defaults, name),
        ownEntry(def.fieldDefaults, name)
      );
      return lowerField(name, spec, enums, literalDefault, executionDefault);
    }),
    indexes: Object.entries(def.indexes ?? {}).map(([name, idx]) => lowerIndex(name, idx)),
    relations: Object.entries(def.relations ?? {}).map(([name, rel]) => lowerRelation(name, rel, def)),
  };
}

/**
 * Validates a `defineContract` input and lowers it into the shared
 * {@link IdbContractDefinition}. Mirrors upstream's `buildContractDefinition`
 * in `@prisma/orm-family-sql/contract-ts`.
 *
 * Applies the client projection first, so every check and the definition see
 * only the models and fields the projected contract keeps.
 *
 * @throws {IdbContractError} With every shared diagnostic. TS input shape errors stay in this front end.
 */
export function buildIdbContractDefinition(
  input: DefineContractInput<EnumDefs>,
  options?: DefineContractOptions
): IdbContractDefinition {
  const projection: ContractProjection = options?.projection ?? "full";
  const enums: EnumDefs = input.enums ?? {};
  const models: Record<string, ProjectedModelDef> =
    projection === "client" ? projectModelsForClient(input.models) : input.models;

  const enumNodes = lowerEnums(enums);

  const definition = {
    enums: enumNodes,
    models: Object.entries(models).map(([modelName, def]) => lowerModel(modelName, def, enums)),
  };
  const diagnostics = validateIdbContractDefinition(definition);
  if (diagnostics.length > 0) throw new IdbContractError(diagnostics);
  return { ...definition, enums: projection === "client" ? keepReferencedEnums(enumNodes, models) : enumNodes };
}

// ── defineContract ────────────────────────────────────────────────────────────

/**
 * Builds a typed IDB contract from a developer-friendly model definition.
 *
 * @throws {IdbContractError} Lists every shared diagnostic with its `IDB_*` code.
 * Unlike upstream TS authoring, which throws the first `CONTRACT.*` error,
 * IDB collects all definition diagnostics before throwing.
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
  return buildIdbContractFromDefinition(buildIdbContractDefinition(input, options));
}
