import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { SyncServerContract } from "./ownership-dag";

/** The SQL storage facts a `1:1` relation's ownership is read from. */
interface SqlModelStorage {
  readonly table?: string;
  readonly namespaceId?: string;
  readonly fields?: Readonly<Record<string, { readonly column?: string }>>;
}

interface SqlForeignKey {
  readonly source: { readonly columns: readonly string[] };
  readonly target: { readonly namespaceId?: string; readonly tableName: string; readonly columns: readonly string[] };
}

/** A to-one relation as the contract stores it. */
interface ToOneRelation {
  readonly cardinality: string;
  readonly to: { readonly model: string };
  readonly on?: { readonly localFields: readonly string[]; readonly targetFields: readonly string[] };
}

const sameColumns = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((column, index) => column === b[index]);

/**
 * Whether `relation`, declared on `modelName`, holds the foreign key, so that
 * ownership flows through it. Every `N:1` does. A `1:1` does on the side whose
 * table declares a foreign key on exactly its local columns to the target's
 * columns, as Prisma 8 SQL records it. The other side of a `1:1` doesn't.
 */
export function ownsForeignKey(contract: SyncServerContract, modelName: string, relation: ToOneRelation): boolean {
  if (relation.cardinality === "N:1") return true;
  if (relation.cardinality !== "1:1" || relation.on === undefined) return false;
  const models = domainModelsAtDefaultNamespace(contract.domain);
  const storage = models[modelName]?.storage as SqlModelStorage | undefined;
  const targetStorage = models[relation.to.model]?.storage as SqlModelStorage | undefined;
  if (!storage?.table || !storage.namespaceId || !targetStorage?.table) return false;
  const namespaces = (
    contract.storage as {
      namespaces?: Record<string, { entries?: { table?: Record<string, { foreignKeys?: readonly SqlForeignKey[] }> } }>;
    }
  ).namespaces;
  const foreignKeys = namespaces?.[storage.namespaceId]?.entries?.table?.[storage.table]?.foreignKeys ?? [];
  const columnsOf = (owner: SqlModelStorage, fields: readonly string[]) =>
    fields.map((field) => owner.fields?.[field]?.column ?? field);
  const local = columnsOf(storage, relation.on.localFields);
  const target = columnsOf(targetStorage, relation.on.targetFields);
  return foreignKeys.some(
    (foreignKey) =>
      sameColumns(foreignKey.source.columns, local) &&
      foreignKey.target.tableName === targetStorage.table &&
      (foreignKey.target.namespaceId === undefined || foreignKey.target.namespaceId === targetStorage.namespaceId) &&
      sameColumns(foreignKey.target.columns, target)
  );
}
