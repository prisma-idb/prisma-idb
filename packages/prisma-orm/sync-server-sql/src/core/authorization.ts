import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { resolveParentReferenceChecks } from "@prisma-idb/sync-server";
import type {
  GetKeyField,
  OwnershipCheck,
  ParentReferenceCheck,
  PushCheck,
  SyncServerContract,
} from "@prisma-idb/sync-server";
import { encodeWireKey } from "./wire-values";
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

  return currentRow ? encodeWireKey(contract, currentModel, rootKeyField, currentRow[rootKeyField]) : null;
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

/** Checks all populated candidate parents without short-circuiting on another parent's success. */
export async function checkParentReferences(
  db: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  check: Extract<PushCheck, { kind: "scoped" }>,
  row: Record<string, unknown>,
  parents: readonly ParentReferenceCheck[]
): Promise<boolean> {
  for (const parent of parents) {
    if (row[parent.localField] == null) {
      if (parent.nullable) continue;
      return false;
    }
    if (!(await checkAuthorization(db, contract, getKeyField, model, { ...check, paths: parent.paths }, row))) {
      return false;
    }
  }
  return true;
}

/** Validates trusted push metadata before opening a transaction, including checks from older callers. */
export function prepareParentReferenceChecks(
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  check: Extract<PushCheck, { kind: "scoped" }>
): readonly ParentReferenceCheck[] {
  const parents = resolveParentReferenceChecks(contract, getKeyField, model, check.paths);
  if (check.parentReferences !== undefined && !sameParentReferences(check.parentReferences, parents)) {
    throw new Error(`Invalid tenant parent descriptors for "${model}".`);
  }
  assertNoParentDefaults(contract, model, parents);
  return parents;
}

function sameParentReferences(
  actual: readonly ParentReferenceCheck[],
  expected: readonly ParentReferenceCheck[]
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((parent, index) => {
      const supplied = actual[index];
      return (
        supplied?.relation === parent.relation &&
        supplied.localField === parent.localField &&
        supplied.nullable === parent.nullable &&
        supplied.paths.length === parent.paths.length &&
        parent.paths.every((path, pathIndex) => {
          const suppliedPath = supplied.paths[pathIndex];
          return suppliedPath?.length === path.length && path.every((relation, hop) => suppliedPath[hop] === relation);
        })
      );
    })
  );
}

/** Defaulted parent FKs need materializing before authorization; this adapter does not support them yet. */
export function assertNoParentDefaults(
  contract: SyncServerContract,
  model: string,
  parents: readonly ParentReferenceCheck[]
): void {
  const storage = domainModelsAtDefaultNamespace(contract.domain)[model]?.storage as
    | {
        namespaceId?: string;
        table?: string;
        fields?: Record<string, { column: string }>;
      }
    | undefined;
  if (!storage?.namespaceId || !storage.table) return;
  const sql = contract.storage as unknown as {
    namespaces: Record<
      string,
      { entries: { table: Record<string, { columns: Record<string, { default?: unknown }> }> } }
    >;
  };
  const columns = sql.namespaces[storage.namespaceId]?.entries.table[storage.table]?.columns;
  for (const parent of parents) {
    const column = storage.fields?.[parent.localField]?.column ?? parent.localField;
    const generated = contract.execution?.mutations.defaults.some(
      ({ ref, onCreate, onUpdate }) =>
        ref.namespace === storage.namespaceId &&
        ref.table === storage.table &&
        ref.column === column &&
        (onCreate || onUpdate)
    );
    if (columns?.[column]?.default !== undefined || generated) {
      throw new Error(
        `Unsupported tenant parent "${model}.${parent.localField}": FK defaults must be resolved before ownership checks. Remove the default and supply the FK explicitly.`
      );
    }
  }
}
