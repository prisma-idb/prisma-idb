/**
 * Runtime validation of enum-typed fields on create/update data.
 *
 * The generated types already narrow enum fields to their literal union, but
 * nothing below the client checks the values: the `idb/string@1` codec passes
 * any value through and IndexedDB stores whatever it is given. A database with
 * native enums rejects an undeclared value on write, so every write path runs
 * {@link assertEnumValues} on its final data (after mutation defaults are
 * applied) before the write is planned.
 */
import type { ContractField } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbContract } from "./types";

type EnumFieldRule = {
  readonly enumName: string;
  readonly values: ReadonlySet<unknown>;
  readonly nullable: boolean;
  readonly many: boolean;
};

type ModelEnumRules = ReadonlyMap<string, EnumFieldRule>;

const rulesByContract = new WeakMap<IdbContract, Map<string, ModelEnumRules>>();

function resolveEnumRule(contract: IdbContract, field: ContractField): EnumFieldRule | undefined {
  const ref = field.valueSet;
  if (ref === undefined || ref.plane !== "domain" || ref.entityKind !== "enum") return undefined;
  const contractEnum = contract.domain.namespaces[ref.namespaceId]?.enum?.[ref.entityName];
  if (contractEnum === undefined) {
    throw new Error(`Enum "${ref.entityName}" referenced by the contract is not declared in its domain.`);
  }
  return {
    enumName: ref.entityName,
    values: new Set(contractEnum.members.map((member) => member.value)),
    nullable: field.nullable,
    many: field.many === true,
  };
}

function getModelEnumRules(contract: IdbContract, modelName: string): ModelEnumRules {
  let byModel = rulesByContract.get(contract);
  if (byModel === undefined) {
    byModel = new Map();
    rulesByContract.set(contract, byModel);
  }
  const cached = byModel.get(modelName);
  if (cached !== undefined) return cached;

  const rules = new Map<string, EnumFieldRule>();
  const fields = domainModelsAtDefaultNamespace(contract.domain)[modelName]?.fields ?? {};
  for (const [fieldName, field] of Object.entries(fields)) {
    const rule = resolveEnumRule(contract, field);
    if (rule !== undefined) rules.set(fieldName, rule);
  }
  byModel.set(modelName, rules);
  return rules;
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : `${String(value)} (${typeof value})`;
}

function invalidValueError(modelName: string, fieldName: string, rule: EnumFieldRule, value: unknown): Error {
  const expected = [...rule.values].map((v) => JSON.stringify(v)).join(", ");
  return new Error(
    `Invalid value ${describe(value)} for enum field "${modelName}.${fieldName}". ` +
      `Expected one of enum "${rule.enumName}": ${expected}.`
  );
}

/**
 * Throws if `data` sets an enum field to a value its enum doesn't declare.
 * Fields left `undefined` are not checked. `null` is accepted only on an
 * optional (`Role?`) field; a list (`Role[]`) field must be an array whose
 * every element is a declared value.
 */
export function assertEnumValues(contract: IdbContract, modelName: string, data: Record<string, unknown>): void {
  const rules = getModelEnumRules(contract, modelName);
  if (rules.size === 0) return;
  for (const [fieldName, rule] of rules) {
    const value = data[fieldName];
    if (value === undefined) continue;
    if (value === null) {
      if (rule.nullable) continue;
      throw new Error(`Enum field "${modelName}.${fieldName}" is required and cannot be null.`);
    }
    if (rule.many) {
      if (!Array.isArray(value)) {
        throw new Error(
          `Enum list field "${modelName}.${fieldName}" expects an array of "${rule.enumName}" values, got ${describe(value)}.`
        );
      }
      for (const element of value) {
        if (!rule.values.has(element)) throw invalidValueError(modelName, fieldName, rule, element);
      }
      continue;
    }
    if (!rule.values.has(value)) throw invalidValueError(modelName, fieldName, rule, value);
  }
}
