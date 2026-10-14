import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbKeyPath } from "@prisma-idb/target-idb/pack";
import { absentAsNull, type AbsentAsNull } from "@prisma-idb/target-idb/runtime";
import { getStoreName, type IdbContract } from "../types";

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
  /** Reads a stored row as the contract describes it: an absent nullable field is `null`. */
  readonly absentAsNull: AbsentAsNull;
}

const catalogs = new WeakMap<IdbContract, Map<string, QueryCatalog>>();

/**
 * Build a catalog once per contract identity, store name and model name.
 * Contracts are immutable.
 *
 * Several models can share one store, and each reads the rows differently.
 * Pass the model that owns the request. Omit `modelName` for a store that no
 * app model owns, such as an extension's own store: it has no fields to fill.
 */
export function buildCatalog(contract: IdbContract, storeName: string, modelName?: string): QueryCatalog {
  const cacheKey = `${storeName}\0${modelName ?? ""}`;
  const cached = catalogs.get(contract)?.get(cacheKey);
  if (cached) return cached;
  const store = contract.storage.stores[storeName];
  if (!store) throw new Error(`Store "${storeName}" is not in the contract`);
  const fields: Record<string, CatalogField> = {};
  let normalize: AbsentAsNull = (row) => row;
  if (modelName !== undefined) {
    const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
    if (model === undefined) throw new Error(`Model "${modelName}" is not in the contract`);
    if (getStoreName(contract, modelName) !== storeName) {
      throw new Error(`Model "${modelName}" is not stored in "${storeName}"`);
    }
    normalize = absentAsNull(contract, modelName);
    for (const [name, field] of Object.entries(model.fields)) {
      fields[name] = Object.freeze({
        codecId: field.type.kind === "scalar" ? field.type.codecId : undefined,
        nullable: field.nullable,
        collection: Boolean(field.many) || field.dict === true,
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
    absentAsNull: normalize,
  });
  let byStore = catalogs.get(contract);
  if (!byStore) {
    byStore = new Map();
    catalogs.set(contract, byStore);
  }
  byStore.set(cacheKey, catalog);
  return catalog;
}

/** Freeze a key source and its field order for deterministic access selection. */
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
