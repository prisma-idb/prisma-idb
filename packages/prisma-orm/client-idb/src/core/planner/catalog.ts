import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbKeyPath } from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "../types";

/** Storage metadata needed to decide whether an index contains every matching row. */
export interface CatalogField {
  readonly codecId: string | undefined;
  readonly nullable: boolean;
  readonly collection: boolean;
}

/** One primary-key or secondary-index source, in declaration order. */
export interface CatalogSource {
  readonly keyPath: IdbKeyPath;
  readonly fields: readonly string[];
  readonly indexName?: string;
  readonly unique: boolean;
  readonly multiEntry: boolean;
}

/** Immutable per-store metadata. No IndexedDB handles are retained. */
export interface QueryCatalog {
  readonly storeName: string;
  readonly primaryKey: CatalogSource;
  readonly indexes: readonly CatalogSource[];
  readonly fields: Readonly<Record<string, CatalogField>>;
}

const catalogs = new WeakMap<IdbContract, Map<string, QueryCatalog>>();

/** Build a catalog once per contract identity and store name. Contracts are immutable. */
export function buildCatalog(contract: IdbContract, storeName: string): QueryCatalog {
  const cached = catalogs.get(contract)?.get(storeName);
  if (cached) return cached;
  const store = contract.storage.stores[storeName];
  if (!store) throw new Error(`Store "${storeName}" is not in the contract`);
  const fields: Record<string, CatalogField> = {};
  for (const model of Object.values(domainModelsAtDefaultNamespace(contract.domain))) {
    if ((model.storage as { storeName?: string }).storeName !== storeName) continue;
    for (const [name, field] of Object.entries(model.fields)) {
      fields[name] = Object.freeze({
        codecId: field.type.kind === "scalar" ? field.type.codecId : undefined,
        nullable: field.nullable,
        collection: field.many === true || field.dict === true,
      });
    }
  }
  const catalog: QueryCatalog = Object.freeze({
    storeName,
    primaryKey: source(store.keyPath, true, false),
    indexes: Object.freeze(
      Object.entries(store.indexes ?? {}).map(([name, index]) =>
        source(index.keyPath, index.unique, index.multiEntry ?? false, name)
      )
    ),
    fields: Object.freeze(fields),
  });
  let byStore = catalogs.get(contract);
  if (!byStore) {
    byStore = new Map();
    catalogs.set(contract, byStore);
  }
  byStore.set(storeName, catalog);
  return catalog;
}

function source(keyPath: IdbKeyPath, unique: boolean, multiEntry: boolean, indexName?: string): CatalogSource {
  const path = typeof keyPath === "string" ? keyPath : Object.freeze([...keyPath]);
  return Object.freeze({
    keyPath: path,
    fields: Object.freeze(typeof path === "string" ? [path] : [...path]),
    unique,
    multiEntry,
    ...(indexName === undefined ? {} : { indexName }),
  });
}
