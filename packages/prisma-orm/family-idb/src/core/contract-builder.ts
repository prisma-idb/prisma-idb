import { computeProfileHash, computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type { ApplicationDomain, Contract, ContractField, CrossReference } from "@prisma/orm-framework/contract/types";
import { UNBOUND_DOMAIN_NAMESPACE_ID, crossRef } from "@prisma/orm-framework/contract/types";
import type {
  IdbIndexDefinition,
  IdbKeyPath,
  IdbModelStorage,
  IdbReferentialAction,
  IdbStorage,
  IdbStoreDefinition,
} from "@prisma-idb/target-idb/pack";
import { keyPathFields } from "@prisma-idb/target-idb/pack";
import type { ContractProjection } from "./psl-interpreter";
import { isValidIdbKeyCodec, literalValueMatchesCodec, warnDroppedRelation } from "./psl-interpreter";
import { validateContract } from "./validate";

// ── Field type system ─────────────────────────────────────────────────────────

type PrismaScalarType = "String" | "Int" | "Float" | "Boolean" | "DateTime" | "BigInt" | "Decimal" | "Json" | "Bytes";

/**
 * A field spec string: the Prisma scalar type name, optionally suffixed with
 * `?` to indicate the field is nullable (e.g. `"String"`, `"Int?"`, `"DateTime?"`).
 */
export type FieldSpec = PrismaScalarType | `${PrismaScalarType}?`;

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

export type RelationDef = {
  readonly to: string;
  readonly cardinality: "1:1" | "1:N" | "N:1";
  readonly on: {
    readonly local: readonly string[];
    readonly target: readonly string[];
  };
  readonly onDelete?: IdbReferentialAction;
  readonly onUpdate?: IdbReferentialAction;
};

export type IndexDef = {
  /** A single field name, or an ordered list of field names for a compound (multi-field) index. */
  readonly keyPath: IdbKeyPath;
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
};

export type ModelDef = {
  readonly store: string;
  /** The primary key field, or an ordered list of fields for a compound primary key. */
  readonly key: IdbKeyPath;
  /** All scalar fields on the model. Use `"Type"` for non-nullable, `"Type?"` for nullable. */
  readonly fields: Record<string, FieldSpec>;
  readonly indexes?: Record<string, IndexDef>;
  readonly relations?: Record<string, RelationDef>;
  /**
   * Literal default values, keyed by field name — feeds the `setDefault`
   * referential action (a child's FK field is reset to its own declared
   * default when its parent is deleted/updated with `onDelete`/`onUpdate:
   * "setDefault"`). A sibling map to `fields`, deliberately not folded into
   * `FieldSpec` (a bare type string) to avoid widening that type.
   *
   * Does NOT feed `create()`'s default-filling — the TS-DSL authoring path
   * has no `execution.mutations.defaults` support at all yet (a separate,
   * larger, pre-existing gap). Use the PSL authoring path's `@default(...)`
   * if you need create-time defaults; this map only backs `setDefault`.
   */
  readonly fieldDefaults?: Record<string, string | number | boolean>;
  /** Server-only model — dropped when `defineContract` runs with `{ projection: "client" }`. See ADR 012. */
  readonly exclude?: boolean;
  /** Server-only fields on an otherwise-synced model — dropped in client projection. See ADR 012. */
  readonly excludeFields?: readonly string[];
};

export type DefineContractInput = {
  /** Pass the default export of `@prisma-idb/family-idb/pack`. */
  readonly family: { readonly familyId: "idb"; readonly id: string };
  /** Pass the default export of `@prisma-idb/target-idb/pack`. */
  readonly target: { readonly targetId: string; readonly id: string };
  readonly models: Record<string, ModelDef>;
};

export type DefineContractOptions = {
  /** @default "full" */
  readonly projection?: ContractProjection;
};

/**
 * Drops `exclude: true` models and `excludeFields` entries for the client
 * projection (ADR 012). Any relation a survivor still has to an excluded
 * model is dropped too (ADR 013) — for every cardinality, required or not;
 * the model itself is never excluded as a result (see ADR 013 §"Why we
 * don't cascade on requiredness"). The underlying FK scalar field (if any)
 * is kept, orphaned but inert.
 */
function projectModelsForClient(models: Record<string, ModelDef>): Record<string, ModelDef> {
  const excludedModelNames = new Set(
    Object.entries(models)
      .filter(([, def]) => def.exclude === true)
      .map(([name]) => name)
  );

  const result: Record<string, ModelDef> = {};

  for (const [modelName, def] of Object.entries(models)) {
    if (excludedModelNames.has(modelName)) continue;

    const excludedFields = new Set(def.excludeFields ?? []);
    const keyFields = keyPathFields(def.key);

    const excludedKeyField = keyFields.find((f) => excludedFields.has(f));
    if (excludedKeyField !== undefined) {
      throw new Error(
        `defineContract: model "${modelName}" excludes its own key field "${excludedKeyField}" — the client contract needs a primary key for every included model.`
      );
    }

    for (const excludedField of excludedFields) {
      if (keyFields.includes(excludedField)) continue;
      if (!(excludedField in def.fields)) {
        throw new Error(
          `defineContract: model "${modelName}" excludeFields references unknown field "${excludedField}" — it is not declared in "fields".`
        );
      }
    }

    for (const [indexName, idx] of Object.entries(def.indexes ?? {})) {
      const excludedIndexField = keyPathFields(idx.keyPath).find((f) => excludedFields.has(f));
      if (excludedIndexField !== undefined) {
        throw new Error(
          `defineContract: model "${modelName}" index "${indexName}" references excluded field "${excludedIndexField}". Remove the index or the exclusion.`
        );
      }
    }

    const relations: Record<string, RelationDef> = {};
    for (const [relName, rel] of Object.entries(def.relations ?? {})) {
      if (excludedModelNames.has(rel.to)) {
        warnDroppedRelation(modelName, relName, rel.to);
        continue;
      }
      const excludedLocalField = rel.on.local.find((f) => excludedFields.has(f));
      if (excludedLocalField !== undefined) {
        throw new Error(
          `defineContract: model "${modelName}" field "${excludedLocalField}" backs relation "${relName}" and cannot be excluded independently — field-level FK exclusion isn't supported (ADR 013 only handles relations pointing at a whole-model @@idb.exclude). Exclude the whole model instead, or remove the exclusion.`
        );
      }
      const targetExcludedFields = new Set(models[rel.to]?.excludeFields ?? []);
      const excludedTargetField = rel.on.target.find((f) => targetExcludedFields.has(f));
      if (excludedTargetField !== undefined) {
        throw new Error(
          `defineContract: model "${modelName}" relation "${relName}" references excluded field "${rel.to}.${excludedTargetField}" — field-level FK exclusion isn't supported (ADR 013 only handles relations pointing at a whole-model @@idb.exclude). Exclude the whole model instead, or remove the exclusion.`
        );
      }
      relations[relName] = rel;
    }

    const fields: Record<string, FieldSpec> = {};
    for (const [fieldName, spec] of Object.entries(def.fields)) {
      if (excludedFields.has(fieldName)) continue;
      fields[fieldName] = spec;
    }

    result[modelName] = { ...def, fields, relations };
  }

  return result;
}

// ── Validate key/index field types against IDB's valid-key algorithm ──────────

function resolveFieldCodecId(def: ModelDef, fieldName: string): string | undefined {
  const spec = def.fields[fieldName];
  if (spec === undefined) return undefined;
  const typeName = (spec.endsWith("?") ? spec.slice(0, -1) : spec) as PrismaScalarType;
  return SCALAR_TO_CODEC_ID[typeName];
}

/**
 * Mirrors `psl-interpreter.ts`'s `IDB_INVALID_KEY_TYPE`/`IDB_INVALID_INDEX_KEY_TYPE`
 * diagnostics for the TS authoring surface, which has no diagnostics array —
 * this DSL fails fast via `throw`, matching every other check in this file.
 *
 * `multiEntry` indexes are skipped: their key-validity depends on the
 * *elements* of an array value, which this scalar-type system can't express
 * (a `multiEntry` index only makes sense over a `Json`-typed field holding an
 * array — the one case this file can't statically validate either way).
 */
function validateModelKeyAndIndexes(modelName: string, def: ModelDef): void {
  const keyFields = keyPathFields(def.key);
  if (keyFields.length === 0) {
    throw new Error(`defineContract: model "${modelName}" "key" must name at least one field.`);
  }
  if (new Set(keyFields).size !== keyFields.length) {
    throw new Error(`defineContract: model "${modelName}" "key" [${keyFields.join(", ")}] repeats a field name.`);
  }

  for (const keyField of keyFields) {
    if (!(keyField in def.fields)) {
      throw new Error(`defineContract: model "${modelName}" key field "${keyField}" is not declared in "fields".`);
    }
    if (def.fields[keyField]?.endsWith("?")) {
      throw new Error(
        `defineContract: model "${modelName}" key field "${keyField}" is nullable ("${def.fields[keyField]}") — the primary key cannot be nullable.`
      );
    }
    const keyCodec = resolveFieldCodecId(def, keyField);
    if (keyCodec !== undefined && !isValidIdbKeyCodec(keyCodec)) {
      throw new Error(
        `defineContract: model "${modelName}" key field "${keyField}" has type "${keyCodec}", which IndexedDB cannot use as a key. Every write would throw (DataError extracting the primary key). Use String, Int, Float, DateTime, Decimal, or Bytes instead.`
      );
    }
  }

  for (const [indexName, idx] of Object.entries(def.indexes ?? {})) {
    const indexFields = keyPathFields(idx.keyPath);
    if (indexFields.length === 0) {
      throw new Error(
        `defineContract: model "${modelName}" index "${indexName}" "keyPath" must name at least one field.`
      );
    }
    if (new Set(indexFields).size !== indexFields.length) {
      throw new Error(
        `defineContract: model "${modelName}" index "${indexName}" "keyPath" [${indexFields.join(", ")}] repeats a field name.`
      );
    }
    if (idx.multiEntry && indexFields.length > 1) {
      throw new Error(
        `defineContract: model "${modelName}" index "${indexName}" combines "multiEntry: true" with a compound "keyPath" [${indexFields.join(", ")}] — IndexedDB rejects this combination (InvalidAccessError). multiEntry only applies to a single array-valued field.`
      );
    }
    for (const indexField of indexFields) {
      if (!(indexField in def.fields)) {
        throw new Error(
          `defineContract: model "${modelName}" index "${indexName}" references field "${indexField}", which is not declared in "fields".`
        );
      }
      if (idx.multiEntry) continue;
      const fieldCodec = resolveFieldCodecId(def, indexField);
      if (fieldCodec === undefined || isValidIdbKeyCodec(fieldCodec)) continue;
      throw new Error(
        `defineContract: model "${modelName}" index "${indexName}" is keyed on "${indexField}" (type "${fieldCodec}"), which IndexedDB cannot use as an index key. Records are silently omitted from the index on write, and any query against it throws at runtime. Use String, Int, Float, DateTime, Decimal, or Bytes instead.`
      );
    }
  }

  for (const [fieldName, value] of Object.entries(def.fieldDefaults ?? {})) {
    if (!(fieldName in def.fields)) {
      throw new Error(
        `defineContract: model "${modelName}" fieldDefaults references field "${fieldName}", which is not declared in "fields".`
      );
    }
    // Mirrors PSL's `literalValueMatchesCodec` check on `@default(...)` — a
    // literal default's JS type must match the field's declared type, and
    // only String/Int/Float/Decimal/Boolean fields accept a literal default
    // at all (matching `ModelDef.fieldDefaults`'s own `string | number |
    // boolean` value type).
    const codec = resolveFieldCodecId(def, fieldName);
    if (codec !== undefined && !literalValueMatchesCodec(value, codec)) {
      throw new Error(
        `defineContract: model "${modelName}" fieldDefaults["${fieldName}"] is a ${typeof value} value, but field "${fieldName}" has type "${def.fields[fieldName]}" — the literal default's JS type must match the field's declared type.`
      );
    }
  }
}

// ── Validate no conflicting reciprocal relation-action declarations ───────────

function sameFieldList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((field, index) => field === b[index]);
}

/**
 * `onDelete`/`onUpdate` may be declared on either side of a relation — unlike
 * PSL (which only permits it on the FK-owning/`N:1` side), TS-DSL relation
 * entries are self-contained and don't require a paired reciprocal
 * declaration at all (see the `posts`-only test below). But if BOTH a
 * relation and its reciprocal declare the *same* kind of action, only the
 * side enforcement actually walks from is ever read at runtime
 * (`getReferentialActionForRelation` in `client-idb/src/core/mutation-executor.ts`
 * checks the direct side first and only falls back to the inverse when the
 * direct side is silent) — so the other side's declaration would be silently
 * ignored. That's a footgun, not a legitimate "pick one" scenario, so it's
 * rejected here instead.
 */
function validateNoConflictingRelationActions(models: Record<string, ModelDef>): void {
  for (const [modelName, def] of Object.entries(models)) {
    for (const [relName, rel] of Object.entries(def.relations ?? {})) {
      const relatedDef = models[rel.to];
      if (!relatedDef) continue;
      for (const [inverseRelName, inverseRel] of Object.entries(relatedDef.relations ?? {})) {
        if (inverseRel.to !== modelName) continue;
        // Mirrors the reciprocal-match predicate in `getReferentialActionForRelation`
        // (client-idb/src/core/mutation-executor.ts) — keep these in sync. Matching on
        // fields (not just `to`) is required: two distinct relations to the same model
        // (e.g. `Message.sender` / `Message.recipient` both -> `User`) are not reciprocals
        // of each other and must not be flagged.
        if (!sameFieldList(inverseRel.on.local, rel.on.target)) continue;
        if (!sameFieldList(inverseRel.on.target, rel.on.local)) continue;

        for (const kind of ["onDelete", "onUpdate"] as const) {
          if (rel[kind] !== undefined && inverseRel[kind] !== undefined) {
            throw new Error(
              `defineContract: relation "${modelName}.${relName}" and its reciprocal "${rel.to}.${inverseRelName}" ` +
                `both declare "${kind}". Only one side is ever read at runtime (whichever side enforcement's cascade ` +
                `walk starts from — the "1:N" side, or the non-owning "1:1" side); the other declaration would be ` +
                `silently ignored. Declare "${kind}" on one side only.`
            );
          }
        }
      }
    }
  }
}

// ── Helper: build ContractField entries from field specs ──────────────────────

function buildFields(fields: Record<string, FieldSpec>): Record<string, ContractField> {
  const result: Record<string, ContractField> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const nullable = spec.endsWith("?");
    const typeName = (nullable ? spec.slice(0, -1) : spec) as PrismaScalarType;
    const codecId = SCALAR_TO_CODEC_ID[typeName];
    if (codecId === undefined) {
      throw new Error(`Unknown field type "${typeName}" for field "${name}"`);
    }
    result[name] = { nullable, type: { kind: "scalar" as const, codecId } };
  }
  return result;
}

// ── Helper: derive the `roots` map (storeName → model CrossReference) ─────────

function buildRoots(models: Record<string, ModelDef>): Record<string, CrossReference> {
  const roots: Record<string, CrossReference> = {};
  for (const modelName of Object.keys(models)) {
    const def = models[modelName]!;
    // v0.12.0: roots values are CrossReference `{ namespace, model }`, not bare
    // model-name strings. IDB has a single (unbound) namespace.
    roots[def.store] = crossRef(modelName);
  }
  return roots;
}

// ── Helper: derive storage.stores from model definitions ─────────────────────

function buildStores(models: Record<string, ModelDef>): Record<string, IdbStoreDefinition> {
  const stores: Record<string, IdbStoreDefinition> = {};
  for (const def of Object.values(models)) {
    const indexes: Record<string, IdbIndexDefinition> = {};
    for (const [indexName, idx] of Object.entries(def.indexes ?? {})) {
      indexes[indexName] = {
        keyPath: idx.keyPath,
        unique: idx.unique ?? false,
        ...(idx.multiEntry !== undefined ? { multiEntry: idx.multiEntry } : {}),
      };
    }
    stores[def.store] = {
      keyPath: def.key,
      ...(Object.keys(indexes).length > 0 ? { indexes } : {}),
    };
  }
  return stores;
}

// ── Helper: build the models section ─────────────────────────────────────────

type ContractModelEntry = {
  readonly fields: Record<string, ContractField>;
  readonly relations: Record<
    string,
    {
      readonly to: CrossReference;
      readonly cardinality: "1:1" | "1:N" | "N:1";
      readonly on: { readonly localFields: readonly string[]; readonly targetFields: readonly string[] };
    }
  >;
  readonly storage: IdbModelStorage;
};

function buildModels(models: Record<string, ModelDef>): Record<string, ContractModelEntry> {
  const result: Record<string, ContractModelEntry> = {};
  for (const [modelName, def] of Object.entries(models)) {
    const relations: ContractModelEntry["relations"] = {};
    const relationsStorage: Record<string, { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction }> = {};
    for (const [relName, rel] of Object.entries(def.relations ?? {})) {
      relations[relName] = {
        // v0.12.0: relation `to` is a CrossReference, not a bare model-name string.
        to: crossRef(rel.to),
        cardinality: rel.cardinality,
        on: { localFields: rel.on.local, targetFields: rel.on.target },
      };
      if (rel.onDelete !== undefined || rel.onUpdate !== undefined) {
        relationsStorage[relName] = {
          ...(rel.onDelete !== undefined ? { onDelete: rel.onDelete } : {}),
          ...(rel.onUpdate !== undefined ? { onUpdate: rel.onUpdate } : {}),
        };
      }
    }
    const storage: IdbModelStorage = {
      storeName: def.store,
      keyPath: def.key,
      ...(Object.keys(relationsStorage).length > 0 ? { relations: relationsStorage } : {}),
      ...(def.fieldDefaults && Object.keys(def.fieldDefaults).length > 0 ? { fieldDefaults: def.fieldDefaults } : {}),
    };
    result[modelName] = { fields: buildFields(def.fields), relations, storage };
  }
  return result;
}

// ── defineContract ────────────────────────────────────────────────────────────

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
export function defineContract(input: DefineContractInput, options?: DefineContractOptions): Contract<IdbStorage> {
  const projection: ContractProjection = options?.projection ?? "full";
  const models = projection === "client" ? projectModelsForClient(input.models) : input.models;

  for (const [modelName, def] of Object.entries(models)) {
    validateModelKeyAndIndexes(modelName, def);
  }
  validateNoConflictingRelationActions(models);

  const stores = buildStores(models);

  // Mirror the capability surface that `prisma contract emit` writes
  // into the JSON contract — keeps the two authoring paths byte-equivalent
  // for the capabilities block. See ARCHITECTURE.md § "Key type: capabilities".
  const capabilities = {
    idb: {
      ddlOnlyInUpgrade: true,
      transactionalDDL: true,
    },
  };

  // v0.12.0 (ADR 221): both planes are namespace-keyed. IDB has no namespace
  // concept, so everything lives under the single unbound namespace.
  const ns = UNBOUND_DOMAIN_NAMESPACE_ID;
  const storageBlock = {
    stores,
    namespaces: { [ns]: { id: ns, entries: {} } },
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

  // v0.12.0: models live under `domain.namespaces.<ns>.models`, not a top-level
  // `models` field.
  const domain = {
    namespaces: { [ns]: { models: buildModels(models) } },
  } as unknown as ApplicationDomain;

  const contract: Contract<IdbStorage> = {
    target: "idb",
    targetFamily: "idb",
    roots: buildRoots(models),
    domain,
    storage,
    capabilities,
    extensions: {},
    meta: {},
    profileHash,
  };

  validateContract(contract);

  return contract;
}
