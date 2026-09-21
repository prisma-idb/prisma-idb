import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField, OwnershipCheck, SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";

/**
 * Walks one of `OwnershipCheck["scoped"].paths` (relation-name chains, e.g.
 * `["board", "user"]`) via the real SQL tables. Sequential single-key
 * lookups, not a nested relation-filter query — simpler to get right
 * against a generic ORM client without deep-diving its expression builder,
 * and these chains are typically 1-2 hops.
 *
 * Returns the resolved root's own key, or null if the chain is broken
 * (missing FK, deleted parent).
 */
export async function resolveRootKeyViaPath(
  db: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  startModel: string,
  startRow: Record<string, unknown>,
  path: readonly string[],
  rootKeyField: string
): Promise<unknown> {
  const models = domainModelsAtDefaultNamespace(contract.domain);

  let currentModel = startModel;
  let currentRow: Record<string, unknown> | null = startRow;

  for (const relationName of path) {
    if (!currentRow) return null;
    const model = models[currentModel];
    const relation = model?.relations[relationName];
    if (!relation || !("on" in relation)) return null; // embed relations have no FK to walk
    const localField = relation.on.localFields[0];
    if (!localField) return null;

    const fkValue: unknown = currentRow[localField];
    if (fkValue == null) return null;

    const targetModel = relation.to.model;
    const targetKeyField = getKeyField(contract, targetModel);
    currentRow = (await ormRootFor(db, targetModel).first({ [targetKeyField]: fkValue })) ?? null;
    currentModel = targetModel;
  }

  return currentRow ? currentRow[rootKeyField] : null;
}

/**
 * Resolves an `OwnershipCheck` to a plain boolean, given the record's
 * current row (`null` for `"root"` checks, which don't need one).
 */
export async function checkAuthorization(
  db: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  check: OwnershipCheck,
  startRow: Record<string, unknown> | null
): Promise<boolean> {
  if (check.kind === "unknown-model") return false;
  if (check.kind === "root") return check.authorized;
  if (!startRow) return false; // record already gone / never existed — nothing to authorize

  for (const path of check.paths) {
    const rootKey = await resolveRootKeyViaPath(db, contract, getKeyField, model, startRow, path, check.rootKeyField);
    if (rootKey === check.scopeKey) return true;
  }
  return false;
}
