import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbContract } from "./types";

/**
 * Throws when `expr` names a field `modelName` doesn't have, as Prisma 8 does.
 * A record has no value for an unknown field, so `where({ typo: null })`
 * would otherwise match every row, and a write would change every row.
 */
export function assertKnownFilterFields(
  contract: IdbContract,
  modelName: string,
  expr: IdbFilterExpr | undefined
): void {
  if (expr === undefined) return;
  const fields = domainModelsAtDefaultNamespace(contract.domain)[modelName]?.fields;
  if (fields === undefined) return;
  const visit = (node: IdbFilterExpr): void => {
    switch (node.kind) {
      case "field":
      case "null-check":
        if (!Object.hasOwn(fields, node.field)) {
          throw new Error(`Model "${modelName}" has no field "${node.field}"`);
        }
        return;
      case "and":
      case "or":
        for (const child of node.exprs) visit(child);
        return;
      case "not":
        visit(node.expr);
        return;
    }
  };
  visit(expr);
}
