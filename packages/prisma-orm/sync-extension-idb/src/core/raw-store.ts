/**
 * Plain reads and writes of one object store by name, issued straight to a
 * transaction scope. Sync uses them for its own stores (`_idb_sync_outbox`,
 * `_idb_sync_version_meta`) and for `applyPull`'s writes, none of which may go
 * through the tracked ORM.
 *
 * The plans built here omit `meta`, the plan metadata the ORM stamps on its
 * own plans; a transaction scope runs them without it. The casts to
 * `IdbAtomicPlan` live in this file only.
 */

import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";

/** Every record in `storeName`, in key order. `T` is the caller's own claim about the record shape. */
export async function scanStore<T extends object = Record<string, unknown>>(
  scope: IdbTransactionScope,
  storeName: string
): Promise<T[]> {
  const rows = await scope.execute({ kind: "cursor-scan", storeName } as unknown as IdbAtomicPlan);
  return rows as unknown as T[];
}

/** The record stored under `key`, or `undefined` if there is none. `T` is the caller's own claim about the record shape. */
export async function getRecord<T extends object = Record<string, unknown>>(
  scope: IdbTransactionScope,
  storeName: string,
  key: IDBValidKey
): Promise<T | undefined> {
  const rows = await scope.execute({ kind: "key-get", storeName, key } as unknown as IdbAtomicPlan);
  return rows[0] as T | undefined;
}

/** Writes `record`, replacing any record with the same key. */
export async function putRecord(scope: IdbTransactionScope, storeName: string, record: object): Promise<void> {
  await scope.execute({ kind: "put", storeName, record } as unknown as IdbAtomicPlan);
}

/** Deletes the record stored under `key`, if any. */
export async function deleteRecord(scope: IdbTransactionScope, storeName: string, key: IDBValidKey): Promise<void> {
  await scope.execute({ kind: "delete", storeName, key } as unknown as IdbAtomicPlan);
}
