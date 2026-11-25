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
