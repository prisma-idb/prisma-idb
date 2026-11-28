import type { ContractField, ContractValueObjectField, ContractWithDomain } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace, valueObjectAt } from "@prisma/orm-framework/contract/types";
import { isJsonCodec, isJsonCompatible } from "./json-value";

// An invalid value must stay invalid until the normal record validator reports its field.
const invalidJson = Symbol("invalid JSON");

function copyJson(value: object): unknown {
  try {
    return isJsonCompatible(value) ? structuredClone(value) : invalidJson;
  } catch {
    return invalidJson;
  }
}

function snapshotFields(
  contract: ContractWithDomain,
  fields: Record<string, ContractField | ContractValueObjectField>,
  data: Record<string, unknown>
): Record<string, unknown> {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return data;
  const snapshot = { ...data };
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(fields, name)) continue;
    const field = fields[name]!;
    const { type } = field;
    if (type.kind === "scalar" && isJsonCodec(type.codecId)) {
      snapshot[name] = copyJson(value);
    } else if (type.kind === "valueObject") {
      const definition = valueObjectAt(contract.storage, type);
      if (!definition) continue;
      const capture = (item: unknown): unknown =>
        item !== null && typeof item === "object"
          ? snapshotFields(contract, definition.fields, item as Record<string, unknown>)
          : item;
      if (field.dict && !Array.isArray(value)) {
        snapshot[name] = Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            field.many && Array.isArray(item) ? item.map(capture) : capture(item),
          ])
        );
      } else if (field.many && Array.isArray(value)) {
        snapshot[name] = value.map(capture);
      } else if (!field.many && !field.dict) {
        snapshot[name] = capture(value);
      }
    }
  }
  return snapshot;
}

/** Capture JSON data before validation so a caller cannot change it while a write is pending. */
export function snapshotJsonFields(
  contract: ContractWithDomain,
  modelName: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  return model ? snapshotFields(contract, model.fields, data) : data;
}
