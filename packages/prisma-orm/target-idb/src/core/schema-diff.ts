import type { IdbIndexDefinition, IdbStoreDefinition } from "./idb-contract-types";
import { keyPathEquals } from "./idb-contract-types";
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
    !keyPathEquals(a.keyPath, b.keyPath) ||
    (a.unique ?? false) !== (b.unique ?? false) ||
    (a.multiEntry ?? false) !== (b.multiEntry ?? false)
  );
}

/** A model move that would reuse an object store from another model. */
export class IdbStoreMoveConflictError extends Error {
  constructor(model: string, storeName: string) {
    super(
      `Cannot move model ${JSON.stringify(model)}: store name ${JSON.stringify(storeName)} is in use. ` +
        "Choose a different store name or author a manual migration to handle the existing records."
    );
    this.name = "IdbStoreMoveConflictError";
  }
}

/**
 * Compute an ordered set of DDL operations to migrate from `from` to `to`.
 *
 * Safe execution order (important for a single `upgradeneeded` transaction):
 * 1. Create new stores — additive
 * 2. Create indexes on those new stores — additive
 * 3. Create new indexes on existing stores — additive
 * 4. Replace mutated indexes on surviving stores — widening + additive
 *    (IDB cannot alter an existing index in place, so this is drop+create)
 * 5. Drop removed indexes from surviving stores — widening
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
 *
 * A model can move to an unused store name if its old name is removed.
 * When both contracts identify the model, reject a move that would reuse
 * an existing store at either name, since that would retain unrelated rows.
 */
export function diffIdbSchema(from: IdbSchemaDiffInput | null, to: IdbSchemaDiffInput): IdbDdlOp[] {
  const fromStores = new Map(Object.entries(from?.stores ?? {}));
  const toStores = new Map(Object.entries(to.stores));
  const ops: IdbDdlOp[] = [];

  const fromStoreByModel = new Map<string, string>();
  for (const [storeName, store] of fromStores) {
    if (store.record !== undefined) fromStoreByModel.set(store.record.model, storeName);
  }
  for (const [storeName, store] of toStores) {
    const model = store.record?.model;
    if (model === undefined || fromStores.get(storeName)?.record?.model === model) continue;
    const oldName = fromStoreByModel.get(model);
    if (oldName === undefined) continue;
    const collision = toStores.has(oldName) ? oldName : fromStores.has(storeName) ? storeName : undefined;
    if (collision !== undefined) throw new IdbStoreMoveConflictError(model, collision);
  }

  // 0. Store-level mutation guard. IDB has no in-place alter for store
  // structure — keyPath / autoIncrement changes are unrecoverable without
  // dropping the store. Fail loudly so the caller can author a manual
  // migration rather than silently misbehaving at runtime.
  for (const [storeName, toDef] of toStores) {
    const fromDef = fromStores.get(storeName);
    if (fromDef === undefined) continue;
    if (!keyPathEquals(fromDef.keyPath, toDef.keyPath)) {
      throw new Error(
        `IDB does not support altering an existing store's keyPath. ` +
          `Store "${storeName}" keyPath changed from ${JSON.stringify(fromDef.keyPath)} to ${JSON.stringify(toDef.keyPath)}. ` +
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
  for (const [storeName, toDef] of toStores) {
    if (fromStores.has(storeName)) continue;
    // Record shape belongs to contract identity, not DDL. Keep only the
    // properties that the migration authoring surface can round-trip.
    const ddlDef: IdbStoreDefinition = {
      keyPath: toDef.keyPath,
      ...(toDef.autoIncrement !== undefined ? { autoIncrement: toDef.autoIncrement } : {}),
      ...(toDef.indexes !== undefined ? { indexes: toDef.indexes } : {}),
    };
    ops.push(createObjectStoreOp(storeName, ddlDef));
    for (const [indexName, indexDef] of Object.entries(toDef.indexes ?? {})) {
      ops.push(createIndexOp(storeName, indexName, indexDef));
    }
  }

  // 3. New indexes on existing stores (additive)
  for (const [storeName, toDef] of toStores) {
    const fromDef = fromStores.get(storeName);
    if (fromDef === undefined) continue; // new store — handled above
    const fromIndexes = fromDef.indexes ?? {};
    for (const [indexName, indexDef] of Object.entries(toDef.indexes ?? {})) {
      if (!Object.hasOwn(fromIndexes, indexName)) {
        ops.push(createIndexOp(storeName, indexName, indexDef));
      }
    }
  }

  // 4. Replace mutated indexes on surviving stores — drop then create.
  // Emit the drop first so the createIndex in the same upgradeneeded
  // transaction sees an available slot. Operation class is "widening"
  // for the drop (policy may filter it) and "additive" for the create.
  for (const [storeName, toDef] of toStores) {
    const fromDef = fromStores.get(storeName);
    if (fromDef === undefined) continue;
    const fromIndexes = fromDef.indexes ?? {};
    const toIndexes = toDef.indexes ?? {};
    for (const [indexName, toIndexDef] of Object.entries(toIndexes)) {
      const fromIndexDef = Object.hasOwn(fromIndexes, indexName) ? fromIndexes[indexName] : undefined;
      if (fromIndexDef === undefined) continue; // new index — already covered by step 3
      if (indexDefinitionsDiffer(fromIndexDef, toIndexDef)) {
        ops.push(dropIndexOp(storeName, indexName));
        ops.push(createIndexOp(storeName, indexName, toIndexDef));
      }
    }
  }

  // 5. Drop removed indexes from surviving stores (widening)
  for (const [storeName, fromDef] of fromStores) {
    if (!toStores.has(storeName)) continue; // whole store gone — handled below
    const toStoreDef = toStores.get(storeName);
    const toIndexes = toStoreDef?.indexes ?? {};
    for (const indexName of Object.keys(fromDef.indexes ?? {})) {
      if (!Object.hasOwn(toIndexes, indexName)) {
        ops.push(dropIndexOp(storeName, indexName));
      }
    }
  }

  // 6. Drop removed stores (destructive)
  for (const storeName of fromStores.keys()) {
    if (!toStores.has(storeName)) {
      ops.push(dropObjectStoreOp(storeName));
    }
  }

  return ops;
}
