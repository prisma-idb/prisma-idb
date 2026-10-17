import { computeExecutionHash, computeProfileHash, computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type {
  ApplicationDomain,
  Contract,
  ContractEnum,
  ContractField,
  CrossReference,
  ExecutionMutationDefault,
} from "@prisma/orm-framework/contract/types";
import { UNBOUND_DOMAIN_NAMESPACE_ID, crossRef } from "@prisma/orm-framework/contract/types";
import type {
  IdbIndexDefinition,
  IdbModelStorage,
  IdbReferentialAction,
  IdbStorage,
  IdbStoreDefinition,
} from "@prisma-idb/target-idb/pack";
import type {
  IdbContractDefinition,
  IdbEnumNode,
  IdbExecutionDefaultNode,
  IdbFieldNode,
  IdbGeneratorNode,
  IdbIndexNode,
  IdbModelNode,
} from "./contract-definition";
import { buildRecordShape } from "./record-shape";
import { validateContract } from "./validate";

/** IDB stores every enum member as a string, so all enums share this codec. */
const ENUM_VALUE_CODEC_ID = "idb/string@1";

/** The domain half of one built model: its fields, join metadata and storage binding. */
type BuiltModel = {
  readonly fields: Record<string, ContractField>;
  readonly relations: Record<
    string,
    {
      readonly to: CrossReference;
      readonly cardinality: "1:1" | "1:N" | "N:1";
      readonly on: { readonly localFields: readonly string[]; readonly targetFields: readonly string[] };
      readonly nullable?: boolean;
    }
  >;
  readonly storage: IdbModelStorage;
};

/** Build the domain enum entries. */
function buildEnums(enums: readonly IdbEnumNode[]): Record<string, ContractEnum> {
  return Object.fromEntries(
    enums.map((node) => [
      node.name,
      {
        codecId: ENUM_VALUE_CODEC_ID,
        members: node.members.map(({ name, value }) => ({ name, value })),
      },
    ])
  );
}

/** Build the domain field for one field node. */
function buildField(node: IdbFieldNode): ContractField {
  return {
    nullable: node.nullable,
    type: { kind: "scalar", codecId: node.codecId },
    ...(node.list ? { many: { elementNullable: false } } : {}),
    ...(node.enumName !== undefined
      ? {
          valueSet: {
            plane: "domain",
            entityKind: "enum",
            namespaceId: UNBOUND_DOMAIN_NAMESPACE_ID,
            entityName: node.enumName,
          },
        }
      : {}),
  };
}

/** Build a model's domain fields in declaration order. */
function buildFields(fields: readonly IdbFieldNode[]): Record<string, ContractField> {
  return Object.fromEntries(fields.map((node) => [node.name, buildField(node)]));
}

/**
 * Build a model's domain relations. Referential actions are IDB storage
 * metadata, so they go to `storage.relations` and not to the domain relation.
 */
function buildRelations(model: IdbModelNode): {
  relations: BuiltModel["relations"];
  relationActions: Record<string, { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction }>;
} {
  const relations: BuiltModel["relations"] = {};
  const relationActions: Record<string, { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction }> = {};
  for (const node of model.relations) {
    relations[node.name] = {
      to: crossRef(node.to),
      cardinality: node.cardinality,
      on: { localFields: node.localFields, targetFields: node.targetFields },
      ...(node.nullable !== undefined ? { nullable: node.nullable } : {}),
    };
    if (node.onDelete !== undefined || node.onUpdate !== undefined) {
      relationActions[node.name] = {
        ...(node.onDelete !== undefined ? { onDelete: node.onDelete } : {}),
        ...(node.onUpdate !== undefined ? { onUpdate: node.onUpdate } : {}),
      };
    }
  }
  return { relations, relationActions };
}

/** Collect the literal defaults that back the `setDefault` referential action. */
function buildFieldDefaults(fields: readonly IdbFieldNode[]): Record<string, string | number | boolean> {
  const defaults: Record<string, string | number | boolean> = {};
  for (const node of fields) {
    if (node.literalDefault !== undefined) defaults[node.name] = node.literalDefault;
  }
  return defaults;
}

/** Build a model's domain entry from its node. */
function buildModel(model: IdbModelNode): BuiltModel {
  const { relations, relationActions } = buildRelations(model);
  const fieldDefaults = buildFieldDefaults(model.fields);
  return {
    fields: buildFields(model.fields),
    relations,
    storage: {
      storeName: model.storeName,
      keyPath: model.key,
      ...(Object.keys(relationActions).length > 0 ? { relations: relationActions } : {}),
      ...(Object.keys(fieldDefaults).length > 0 ? { fieldDefaults } : {}),
    },
  };
}

/** Build the object-store index definitions for one model. */
function buildIndexes(indexes: readonly IdbIndexNode[]): Record<string, IdbIndexDefinition> {
  return Object.fromEntries(
    indexes.map((node) => [
      node.name,
      {
        keyPath: node.keyPath,
        unique: node.unique,
        ...(node.multiEntry !== undefined ? { multiEntry: node.multiEntry } : {}),
      },
    ])
  );
}

/** Build one object store, including the canonical record shape that feeds the storage hash. */
function buildStore(model: IdbModelNode, built: BuiltModel, enums: Record<string, ContractEnum>): IdbStoreDefinition {
  const indexes = buildIndexes(model.indexes);
  return {
    record: buildRecordShape(model.modelName, built.fields, { enum: enums }),
    keyPath: model.key,
    ...(model.autoIncrement ? { autoIncrement: true } : {}),
    ...(Object.keys(indexes).length > 0 ? { indexes } : {}),
  };
}

/** Wrap a generator node in the contract's generator shape. */
function buildGenerator(node: IdbGeneratorNode) {
  return { kind: "generator" as const, id: node.id, ...(node.params !== undefined ? { params: node.params } : {}) };
}

/** Build the execution-plane default for one field. */
function buildExecutionDefault(
  model: IdbModelNode,
  fieldName: string,
  node: IdbExecutionDefaultNode
): ExecutionMutationDefault {
  return {
    ref: { namespace: UNBOUND_DOMAIN_NAMESPACE_ID, entry: model.storeName, field: fieldName },
    ...(node.onCreate ? { onCreate: buildGenerator(node.onCreate) } : {}),
    ...(node.onUpdate ? { onUpdate: buildGenerator(node.onUpdate) } : {}),
  };
}

/** Collect the execution-plane defaults of every model, in model then field order. */
function buildExecutionDefaults(models: readonly IdbModelNode[]): ExecutionMutationDefault[] {
  return models.flatMap((model) =>
    model.fields.flatMap((field) =>
      field.executionDefault !== undefined ? [buildExecutionDefault(model, field.name, field.executionDefault)] : []
    )
  );
}

/**
 * Assembles an IDB contract from a definition and computes its storage,
 * profile and execution hashes.
 *
 * This is the only place that builds the contract's storage, models, roots and
 * enums, and the only place that hashes. Because every authoring surface goes
 * through it, equivalent definitions always produce the same hashes. Mirrors
 * upstream's `buildSqlContractFromDefinition`.
 *
 * @throws When the assembled contract fails `validateContract`.
 */
export function buildIdbContractFromDefinition(definition: IdbContractDefinition): Contract<IdbStorage> {
  const ns = UNBOUND_DOMAIN_NAMESPACE_ID;
  const enums = buildEnums(definition.enums);
  const builtModels = definition.models.map((model) => [model, buildModel(model)] as const);

  const stores: Record<string, IdbStoreDefinition> = {};
  const roots: Record<string, CrossReference> = {};
  const domainModels: Record<string, BuiltModel> = {};
  for (const [model, built] of builtModels) {
    stores[model.storeName] = buildStore(model, built, enums);
    roots[model.storeName] = crossRef(model.modelName);
    domainModels[model.modelName] = built;
  }

  // Mirrors the capability surface that `prisma contract emit` writes into the
  // JSON contract, so every authoring path agrees on the capabilities block.
  const capabilities = { idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } };

  // IDB has no namespaces, so everything lives under the single unbound one.
  const storageBlock = { stores, namespaces: { [ns]: { id: ns, entries: {} } } };

  const storageHash = computeStorageHash({ target: "idb", targetFamily: "idb", storage: storageBlock });
  const profileHash = computeProfileHash({ target: "idb", targetFamily: "idb", capabilities });

  const executionDefaults = buildExecutionDefaults(definition.models);
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

  // Models live under `domain.namespaces.<ns>.models`, next to the enums.
  const domain = {
    namespaces: {
      [ns]: {
        models: domainModels,
        ...(Object.keys(enums).length > 0 ? { enum: enums } : {}),
      },
    },
  } as unknown as ApplicationDomain;

  const contract: Contract<IdbStorage> = {
    target: "idb",
    targetFamily: "idb",
    roots,
    domain,
    storage: { ...storageBlock, storageHash },
    capabilities,
    extensions: {},
    meta: {},
    profileHash,
    ...(execution ? { execution } : {}),
  };

  validateContract(contract);
  return contract;
}
