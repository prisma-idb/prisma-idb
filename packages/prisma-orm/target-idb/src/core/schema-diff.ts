import type { IdbIndexDefinition, IdbStoreDefinition } from "./idb-contract-types";
import {
  createIndexOp,
  createObjectStoreOp,
  dropIndexOp,
  dropObjectStoreOp,
  type IdbDdlOp,
} from "./migration-factories";

/**
 * Minimal schema shape used for diffing.
 *
 * Structurally identical to `IdbSchemaIR` in `family-idb` — compatible by
 * TypeScript's structural typing. The contract's `storage.stores` map
 * (which uses `IdbStoreDefinition`) has the same shape as `IdbStoreIR`, so
 * both can be passed here without conversion.
 */
export type IdbSchemaDiffInput = {
  readonly stores: Record<string, IdbStoreDefinition>;
};

/**
 * Returns `true` if the two index definitions differ in any property that
 * IDB cannot alter in place. IDB does not support mutating an existing
 * index's `keyPath`, `unique`, or `multiEntry` — the only path is
 * drop-then-create. We normalise `unique` and `multiEntry` to `false` when
 * absent so default-stripped contracts compare cleanly.
 */
function indexDefinitionsDiffer(a: IdbIndexDefinition, b: IdbIndexDefinition): boolean {
  return (
    a.keyPath !== b.keyPath ||
    (a.unique ?? false) !== (b.unique ?? false) ||
    (a.multiEntry ?? false) !== (b.multiEntry ?? false)
  );
}

/**
 * Compute an ordered set of DDL operations to migrate from `from` to `to`.
 *
 * Safe execution order (important for a single `upgradeneeded` transaction):
 * 1. Create new stores — additive
 * 2. Create indexes on those new stores — additive
 * 3. Create new indexes on existing stores — additive
 * 4. Replace mutated indexes on surviving stores — destructive + additive
 *    (IDB cannot alter an existing index in place, so this is drop+create)
 * 5. Drop removed indexes from surviving stores — destructive
 * 6. Drop removed stores — destructive
 *
 * @param from - Current schema, or `null` for a fresh (empty) database.
 * @param to   - Desired target schema.
 *
 * **Note on store-level mutations.** IDB cannot alter an object store's
 * `keyPath` or `autoIncrement` after creation. When those change between
 * `from` and `to` for the same store name, this function throws — silent
 * no-op is worse than an explicit error. The recovery path is a manual
 * migration that drops the store and re-creates it (with whatever data
 * preservation strategy the caller wants).
 */
export function diffIdbSchema(from: IdbSchemaDiffInput | null, to: IdbSchemaDiffInput): IdbDdlOp[] {
  const fromStores = from?.stores ?? {};
  const toStores = to.stores;
  const ops: IdbDdlOp[] = [];

  // 0. Store-level mutation guard. IDB has no in-place alter for store
  // structure — keyPath / autoIncrement changes are unrecoverable without
  // dropping the store. Fail loudly so the caller can author a manual
  // migration rather than silently misbehaving at runtime.
  for (const [storeName, toDef] of Object.entries(toStores)) {
    const fromDef = fromStores[storeName];
    if (fromDef === undefined) continue;
    if (fromDef.keyPath !== toDef.keyPath) {
      throw new Error(
        `IDB does not support altering an existing store's keyPath. ` +
          `Store "${storeName}" keyPath changed from "${fromDef.keyPath}" to "${toDef.keyPath}". ` +
          `Author a manual migration that drops and re-creates the store with the desired data flow.`
      );
    }
    if ((fromDef.autoIncrement ?? false) !== (toDef.autoIncrement ?? false)) {
      throw new Error(
        `IDB does not support altering an existing store's autoIncrement flag. ` +
          `Store "${storeName}" autoIncrement changed from ${fromDef.autoIncrement ?? false} ` +
          `to ${toDef.autoIncrement ?? false}. Author a manual migration that drops and re-creates the store.`
      );
    }
  }

  // 1 + 2. New stores and their indexes (additive)
  for (const [storeName, toDef] of Object.entries(toStores)) {
    if (storeName in fromStores) continue;
    ops.push(createObjectStoreOp(storeName, toDef));
    for (const [indexName, indexDef] of Object.entries(toDef.indexes ?? {})) {
      ops.push(createIndexOp(storeName, indexName, indexDef));
    }
  }

  // 3. New indexes on existing stores (additive)
  for (const [storeName, toDef] of Object.entries(toStores)) {
    const fromDef = fromStores[storeName];
    if (fromDef === undefined) continue; // new store — handled above
    const fromIndexes = fromDef.indexes ?? {};
    for (const [indexName, indexDef] of Object.entries(toDef.indexes ?? {})) {
      if (!(indexName in fromIndexes)) {
        ops.push(createIndexOp(storeName, indexName, indexDef));
      }
    }
  }

  // 4. Replace mutated indexes on surviving stores — drop then create.
  // Emit the drop first so the createIndex in the same upgradeneeded
  // transaction sees an available slot. Operation class is "destructive"
  // for the drop (policy may filter it) and "additive" for the create.
  for (const [storeName, toDef] of Object.entries(toStores)) {
    const fromDef = fromStores[storeName];
    if (fromDef === undefined) continue;
    const fromIndexes = fromDef.indexes ?? {};
    const toIndexes = toDef.indexes ?? {};
    for (const [indexName, toIndexDef] of Object.entries(toIndexes)) {
      const fromIndexDef = fromIndexes[indexName];
      if (fromIndexDef === undefined) continue; // new index — already covered by step 3
      if (indexDefinitionsDiffer(fromIndexDef, toIndexDef)) {
        ops.push(dropIndexOp(storeName, indexName));
        ops.push(createIndexOp(storeName, indexName, toIndexDef));
      }
    }
  }

  // 5. Drop removed indexes from surviving stores (destructive)
  for (const [storeName, fromDef] of Object.entries(fromStores)) {
    if (!(storeName in toStores)) continue; // whole store gone — handled below
    const toStoreDef = toStores[storeName];
    const toIndexes = toStoreDef?.indexes ?? {};
    for (const indexName of Object.keys(fromDef.indexes ?? {})) {
      if (!(indexName in toIndexes)) {
        ops.push(dropIndexOp(storeName, indexName));
      }
    }
  }

  // 6. Drop removed stores (destructive)
  for (const storeName of Object.keys(fromStores)) {
    if (!(storeName in toStores)) {
      ops.push(dropObjectStoreOp(storeName));
    }
  }

  return ops;
}
