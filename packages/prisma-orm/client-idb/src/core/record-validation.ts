import { validateRecord } from "@prisma-idb/target-idb/runtime";
import { getKeyPath, getStoreName, type IdbContract } from "./types";

/** A local ORM create or update failed the contract's native record validation. */
export class IdbRecordValidationError extends Error {
  constructor(
    readonly modelName: string,
    readonly operation: "create" | "update",
    readonly issues: readonly string[]
  ) {
    super(`Invalid ${operation} record for "${modelName}": ${issues.join("; ")}`);
    this.name = "IdbRecordValidationError";
  }
}

/** Validate final write data, after defaults and relation scalar values are resolved. */
export function assertValidRecord(
  contract: IdbContract,
  modelName: string,
  operation: "create" | "update",
  data: Record<string, unknown>
): void {
  const keyPath = getKeyPath(contract, modelName);
  const store = contract.storage.stores[getStoreName(contract, modelName)];
  // Only IndexedDB's native key generator may leave a create field absent.
  const optionalFields =
    operation === "create" && store?.autoIncrement && typeof keyPath === "string" && !Object.hasOwn(data, keyPath)
      ? [keyPath]
      : [];
  const result = validateRecord(contract, modelName, data, { partial: operation === "update", optionalFields });
  if (!result.ok) throw new IdbRecordValidationError(modelName, operation, result.issues);
}
