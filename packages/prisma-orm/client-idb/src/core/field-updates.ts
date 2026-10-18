import { type ContractField, domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { keyPathFields } from "@prisma-idb/target-idb/pack";
import { compareListElement } from "@prisma-idb/target-idb/runtime";
import { assertValidRecord } from "./record-validation";
import { assertEnumValues } from "./enum-validation";
import { getKeyPath, type DefaultModelRow, type IdbContract, type ModelKeyPath } from "./types";

/** A fluent field update, following the Prisma 8 Mongo field-operation shape. */
export interface IdbFieldOperation {
  readonly operator: "$set" | "$push" | "$pull" | "$addToSet" | "$pop" | "$unset";
  readonly field: string;
  readonly value?: unknown;
}

/** Operations on a required list; unset is rejected because stored lists must remain present. */
export type IdbFieldExpression<T> = {
  set(value: T): IdbFieldOperation;
} & (unknown extends T
  ? IdbListExpression<unknown>
  : T extends readonly (infer Element)[]
    ? IdbListExpression<Element>
    : unknown);

/** Element operations shared by typed lists and dynamically built contracts. */
type IdbListExpression<Element> = {
  push(value: Element): IdbFieldOperation;
  pull(value: Element): IdbFieldOperation;
  addToSet(value: Element): IdbFieldOperation;
  pop(end: 1 | -1): IdbFieldOperation;
};

/** Mutable model fields available to a fluent update callback. */
export type IdbUpdateAccessor<TContract, ModelName extends string> = {
  readonly [
    K in Exclude<keyof DefaultModelRow<TContract, ModelName>, ModelKeyPath<TContract, ModelName>>
  ]-?: IdbFieldExpression<DefaultModelRow<TContract, ModelName>[K]>;
};

/** A callback is evaluated once, before the transaction, and returns declarative field operations. */
export type IdbUpdateCallback<TContract, ModelName extends string> = (
  fields: IdbUpdateAccessor<TContract, ModelName>
) => readonly IdbFieldOperation[];

/** The scalar patch plus operations that need the current row in the mutation transaction. */
export interface ResolvedFieldUpdates {
  readonly patch: Record<string, unknown>;
  readonly operations: readonly IdbFieldOperation[];
}

/** Create a declarative accessor; operation validation happens before opening the transaction. */
function createUpdateAccessor(): object {
  return new Proxy(
    {},
    {
      get: (_target, field: string) =>
        Object.fromEntries(
          ["set", "push", "pull", "addToSet", "pop", "unset"].map((op) => [
            op,
            (value: unknown) => ({ operator: `$${op}`, field, value }),
          ])
        ),
    }
  );
}

/** Validate an element operand with the same record and enum validators as a normal write. */
function assertListOperation(
  contract: IdbContract,
  modelName: string,
  definition: ContractField,
  operation: IdbFieldOperation
): void {
  const { field, operator, value } = operation;
  if (!definition.many || definition.type.kind !== "scalar")
    throw new TypeError(`Field "${field}" is not a scalar list`);
  if (operator === "$unset") throw new TypeError(`Required list "${field}" cannot be unset`);
  if (!["$push", "$pull", "$addToSet", "$pop"].includes(operator))
    throw new TypeError(`Unsupported list operation "${operator}"`);
  if (operator === "$pop" && value !== 1 && value !== -1) throw new TypeError("pop() expects 1 or -1");
  const operand = { [field]: operator === "$pop" ? [] : [value] };
  assertEnumValues(contract, modelName, operand);
  assertValidRecord(contract, modelName, "update", operand);
}

/** Build and validate the update description even when its query matches no rows. */
export function resolveFieldUpdates(contract: IdbContract, modelName: string, input: unknown): ResolvedFieldUpdates {
  if (typeof input !== "function") return { patch: input as Record<string, unknown>, operations: [] };
  const accessor = createUpdateAccessor();
  const operations: unknown = input(accessor);
  if (!Array.isArray(operations)) throw new TypeError("An update callback must return field operations");
  const fields = domainModelsAtDefaultNamespace(contract.domain)[modelName]!.fields;
  const keys = keyPathFields(getKeyPath(contract, modelName)).map((key) => key.split(".")[0]);
  const patch: Record<string, unknown> = Object.create(null);
  const pending: IdbFieldOperation[] = [];
  for (const operation of operations as IdbFieldOperation[]) {
    if (!operation || !Object.hasOwn(fields, operation.field)) throw new TypeError("Unknown field in update callback");
    const { field, operator, value } = operation;
    if (keys.includes(field)) throw new TypeError(`Cannot update primary-key field "${field}"`);
    if (Object.hasOwn(patch, field)) throw new TypeError(`Conflicting update operations on field "${field}"`);
    if (operator === "$set") patch[field] = value;
    else {
      assertListOperation(contract, modelName, fields[field]!, operation);
      // Declare the written field for defaults and transaction store collection. It is resolved per row below.
      patch[field] = [];
      pending.push(operation);
    }
  }
  assertEnumValues(contract, modelName, patch);
  assertValidRecord(contract, modelName, "update", patch);
  return { patch, operations: pending };
}

/** Resolve list operations from the row read inside the same transaction as the write. */
export function applyFieldUpdates(
  contract: IdbContract,
  modelName: string,
  updates: ResolvedFieldUpdates,
  row: Record<string, unknown>
): Record<string, unknown> {
  if (updates.operations.length === 0) return updates.patch;
  const patch = { ...updates.patch };
  const fields = domainModelsAtDefaultNamespace(contract.domain)[modelName]!.fields;
  for (const { field, operator, value } of updates.operations) {
    const current = row[field];
    if (!Array.isArray(current))
      throw new TypeError(`Stored list "${modelName}.${field}" is missing or invalid; migrate the store first`);
    const type = fields[field]!.type;
    const codecId = type.kind === "scalar" ? type.codecId : undefined;
    const equal = (element: unknown) => compareListElement(codecId, element, value) === 0;
    switch (operator) {
      case "$push":
        patch[field] = [...current, value];
        break;
      case "$pull":
        patch[field] = current.filter((element) => !equal(element));
        break;
      case "$addToSet":
        patch[field] = current.some(equal) ? [...current] : [...current, value];
        break;
      case "$pop":
        patch[field] = value === -1 ? current.slice(1) : current.slice(0, -1);
        break;
    }
  }
  return patch;
}
