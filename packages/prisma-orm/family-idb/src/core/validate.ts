import type { Contract } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { ContractValidationError } from "@prisma/orm-framework/contract/contract-validation-error";
import { validateContractDomain } from "@prisma/orm-framework/contract/validate-domain";
import type { IdbKeyPath, IdbModelStorage, IdbStorage } from "@prisma-idb/target-idb/pack";

/**
 * `true` if `keyPath` is a well-formed {@link IdbKeyPath}: a non-empty string,
 * or a non-empty array of non-empty, pairwise-distinct field names (a
 * compound key can't repeat a field, and every member must actually name a
 * field — an empty string in the list is never valid).
 */
function isWellFormedKeyPath(keyPath: unknown): keyPath is IdbKeyPath {
  if (typeof keyPath === "string") return keyPath !== "";
  if (!Array.isArray(keyPath) || keyPath.length === 0) return false;
  if (!keyPath.every((f) => typeof f === "string" && f !== "")) return false;
  return new Set(keyPath).size === keyPath.length;
}

/** Fully-typed IDB contract after validation. */
export type IdbContract = Contract<IdbStorage>;

/**
 * Validates the IDB-specific storage block of a contract.
 *
 * Runs after the framework's {@link validateContractDomain} (structural +
 * domain validation). Checks:
 *
 * 1. `storage.stores` is present and is an object.
 * 2. Every store has a well-formed `keyPath` (a non-empty field name, or a
 *    non-empty array of distinct field names for a compound key).
 * 3. Every model's `storage.storeName` references an existing store.
 *
 * @throws {@link ContractValidationError} with phase `'storage'` on failure.
 */
function validateIdbStorage(contract: Contract): void {
  const storage = contract.storage as unknown as Partial<IdbStorage> | undefined;

  if (!storage || typeof storage.stores !== "object" || storage.stores === null) {
    throw new ContractValidationError("IDB contract must have storage.stores (an object)", "storage");
  }

  // Validate each store has a well-formed keyPath (a non-empty string, or a
  // non-empty array of distinct non-empty field names for a compound key).
  for (const [storeName, store] of Object.entries(storage.stores)) {
    if (!store || !isWellFormedKeyPath(store.keyPath)) {
      throw new ContractValidationError(
        `Store "${storeName}" is missing a required keyPath (a non-empty field name, or a non-empty array of ` +
          "distinct field names for a compound key)",
        "storage"
      );
    }
  }

  // Validate model → store references. Models live under
  // `domain.namespaces.<ns>.models`; resolved via `domainModelsAtDefaultNamespace`.
  const storeNames = new Set(Object.keys(storage.stores));
  const models = domainModelsAtDefaultNamespace(contract.domain) as Record<
    string,
    { storage?: Partial<IdbModelStorage> }
  >;

  for (const [modelName, model] of Object.entries(models)) {
    const storeName = model.storage?.storeName;
    if (!storeName) {
      throw new ContractValidationError(`Model "${modelName}" is missing storage.storeName`, "storage");
    }
    if (!storeNames.has(storeName)) {
      throw new ContractValidationError(`Model "${modelName}" references non-existent store "${storeName}"`, "storage");
    }
  }
}

/**
 * Parses and validates a raw contract value against the IDB contract schema.
 *
 * Runs two validation passes: framework domain validation then IDB-specific
 * storage validation. Throws a {@link ContractValidationError} describing the
 * first failure found.
 *
 * @param value - Raw contract value (e.g. parsed from `contract.json`).
 * @returns The validated, fully-typed {@link IdbContract}.
 */
export function validateContract(value: unknown): IdbContract {
  // In v0.11.0 the contract arrives already structurally parsed (it's a
  // Contract object, not raw JSON). Domain validation checks roots, models,
  // valueObjects, and relations.
  const contract = value as Contract;
  validateContractDomain(contract);
  validateIdbStorage(contract);
  return contract as IdbContract;
}
