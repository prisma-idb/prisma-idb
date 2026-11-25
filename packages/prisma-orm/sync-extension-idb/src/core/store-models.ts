import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";

const storeToModelCache = new WeakMap<IdbContract, ReadonlyMap<string, string>>();

/**
 * The model stored in `storeName`, or `undefined` for a store no model uses.
 * Plans inside a transaction scope carry only a store name. Cached per contract,
 * since it's static for a given contract instance.
 */
export function getModelNameForStore(contract: IdbContract, storeName: string): string | undefined {
  let map = storeToModelCache.get(contract);
  if (!map) {
    const built = new Map<string, string>();
    for (const [modelName, model] of Object.entries(domainModelsAtDefaultNamespace(contract.domain))) {
      const modelStoreName = (model as { storage?: { storeName?: string } }).storage?.storeName;
      if (modelStoreName) built.set(modelStoreName, modelName);
    }
    map = built;
    storeToModelCache.set(contract, map);
  }
  return map.get(storeName);
}

/** An N:1 relation of a domain model, as foreign-key checks read it. */
export interface ManyToOneRelation {
  readonly to: string | { readonly model: string };
  readonly cardinality: string;
  readonly on: { readonly localFields: readonly string[]; readonly targetFields: readonly string[] };
}

/** The N:1 relations of `model`, whose local fields are foreign keys. */
export function manyToOneRelations(contract: IdbContract, model: string): readonly ManyToOneRelation[] {
  const relations = (
    domainModelsAtDefaultNamespace(contract.domain)[model] as
      { relations?: Record<string, ManyToOneRelation> } | undefined
  )?.relations;
  return Object.values(relations ?? {}).filter((relation) => relation.cardinality === "N:1");
}

/**
 * The foreign-key fields of every N:1 relation that `patch` touches. A relation
 * counts when the patch lists any of its fields, and then all its fields are
 * returned, since a compound key is compared as a whole.
 */
export function foreignKeyFieldsIn(contract: IdbContract, model: string, patch: Record<string, unknown>): string[] {
  const fields = new Set<string>();
  for (const { on } of manyToOneRelations(contract, model)) {
    if (on.localFields.some((field) => field in patch)) for (const field of on.localFields) fields.add(field);
  }
  return [...fields];
}
