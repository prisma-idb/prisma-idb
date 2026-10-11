import type { ContractWithDomain } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";

/** Fills the nullable fields a stored record lacks with `null`. Returns the record itself when none is missing. */
export type AbsentAsNull = (record: Record<string, unknown>) => Record<string, unknown>;

// Contracts are immutable for the lifetime of a runtime.
const normalizers = new WeakMap<ContractWithDomain, Map<string, AbsentAsNull>>();

/**
 * Reads a stored record as the contract describes it: a nullable field the record lacks is `null`.
 * A field added after the record was written is the usual cause. Reading it as `null` means adding
 * a nullable field needs no walk over the stored records, and `validateRecord` stays strict.
 *
 * The normalizer is built once per model, so each record costs one check per nullable field.
 */
export function absentAsNull(contract: ContractWithDomain, modelName: string): AbsentAsNull {
  let byModel = normalizers.get(contract);
  if (!byModel) {
    byModel = new Map();
    normalizers.set(contract, byModel);
  }
  const cached = byModel.get(modelName);
  if (cached) return cached;

  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  if (!model) throw new Error(`Unknown model "${modelName}"`);
  const nullableFields = Object.entries(model.fields)
    .filter(([, field]) => field.nullable)
    .map(([name]) => name);
  const normalize: AbsentAsNull = (record) => {
    let filled: Record<string, unknown> | undefined;
    for (const name of nullableFields) {
      // `hasOwn` keeps a field named like an `Object.prototype` member, such as `toString`, from reading as stored.
      if (!Object.hasOwn(record, name) || record[name] === undefined) (filled ??= { ...record })[name] = null;
    }
    return filled ?? record;
  };
  byModel.set(modelName, normalize);
  return normalize;
}
