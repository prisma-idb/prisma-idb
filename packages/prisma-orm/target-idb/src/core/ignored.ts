import type { ContractWithDomain } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbModelStorage } from "./idb-contract-types";

/** The IDB storage metadata of one model, if the model exists. */
function modelStorage(contract: ContractWithDomain, modelName: string): IdbModelStorage | undefined {
  return domainModelsAtDefaultNamespace(contract.domain)[modelName]?.storage as IdbModelStorage | undefined;
}

/**
 * `true` for an `@@ignore` model. The model keeps its store, records, foreign
 * keys and referential actions, but the client has no accessor for it.
 */
export function isIgnoredModel(contract: ContractWithDomain, modelName: string): boolean {
  return modelStorage(contract, modelName)?.ignored === true;
}

/**
 * `true` for a relation the client hides: `@ignore` on either side, or a
 * relation of or to an `@@ignore` model. The relation still enforces its
 * foreign key and referential actions; only `include()` and nested writes
 * refuse it.
 */
export function isIgnoredRelation(contract: ContractWithDomain, modelName: string, relationName: string): boolean {
  return modelStorage(contract, modelName)?.relations?.[relationName]?.ignored === true;
}
