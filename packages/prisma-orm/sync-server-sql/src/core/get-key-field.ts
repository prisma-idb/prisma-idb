import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField } from "@prisma-idb/sync-server";

/**
 * SQL's primary key doesn't live where IDB's does (`sync-server`'s default
 * `getKeyField` duck-types `model.storage.keyPath`, which SQL contracts
 * don't have at all) — it's on the table definition, as a possibly-compound
 * array: `contract.storage.namespaces[ns].entries.table[table].primaryKey.columns`.
 * Only single-field keys are supported — a compound result throws rather
 * than silently picking one column.
 */
export const sqlGetKeyField: GetKeyField = (contract, modelName) => {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const storage = model?.storage as { table?: string; namespaceId?: string } | undefined;
  if (!storage?.table || !storage.namespaceId) {
    throw new Error(`Model "${modelName}" has no table/namespaceId in the contract's storage.`);
  }
  const table = (
    contract.storage as unknown as {
      namespaces: Record<string, { entries: { table: Record<string, { primaryKey: { columns: string[] } }> } }>;
    }
  ).namespaces[storage.namespaceId]?.entries.table[storage.table];
  const columns = table?.primaryKey?.columns;
  if (!columns || columns.length !== 1) {
    throw new Error(
      `Model "${modelName}" has no single-column primary key (got ${columns?.length ?? 0}) — ` +
        `compound keys aren't supported.`
    );
  }
  return columns[0]!;
};
