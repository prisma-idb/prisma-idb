/**
 * Identity of a `_idb_sync_version_meta` record. The sync executor writes it
 * when a local mutation is tracked, `applyPull` looks it up when a server
 * change arrives, and `markSynced` reads it back from `OutboxEvent.versionMetaId`
 * — all three must resolve the same metadata record for numerically equal Decimal keys.
 */

import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { getKeyPath, extractKeyFromRow } from "@prisma-idb/client-idb/orm";
import {
  decimalKeysEqual,
  hasDecimalPrimaryKey,
  preserveDecimalKeySpelling,
  IdbDecimalIdentityConflictError,
} from "@prisma-idb/client-idb/internal";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { VersionMetaRecord } from "../types";
import { decodeJsonRecord, validateKeyPath } from "@prisma-idb/target-idb/runtime";
import { getRecord, scanStore } from "./raw-store";

export const VERSION_META_STORE = "_idb_sync_version_meta";

/** The `_idb_sync_version_meta` id for the record of `modelName` stored under `key`. */
export function versionMetaKey(modelName: string, key: unknown): string {
  return `${modelName}::${JSON.stringify(key)}`;
}

/** Find metadata aliases even after a local delete removed the application row. */
export async function resolveVersionMeta(
  scope: IdbTransactionScope,
  contract: IdbContract,
  model: string,
  key: IDBValidKey,
  wireKey: unknown = key,
  snapshot?: ReadonlyMap<string, VersionMetaRecord>
): Promise<VersionMetaRecord | undefined> {
  const id = versionMetaKey(model, wireKey);
  const exact = snapshot ? snapshot.get(id) : await getRecord<VersionMetaRecord>(scope, VERSION_META_STORE, id);
  if (!hasDecimalPrimaryKey(contract, model)) return exact;
  const rows = snapshot ? [...snapshot.values()] : await scanStore<VersionMetaRecord>(scope, VERSION_META_STORE);
  const matches = rows.filter(
    (meta) =>
      meta.model === model && decimalKeysEqual(contract, model, nativeVersionMetaKey(contract, model, meta.key), key)
  );
  if (matches.length > 1) throw new IdbDecimalIdentityConflictError(model);
  return matches[0];
}

/** Older pull metadata can hold wire-form Date/Bytes parts beside native local keys. */
export function nativeVersionMetaKey(contract: IdbContract, model: string, key: unknown): unknown {
  if (validateKeyPath(contract, model, key).ok) return key;
  const path = getKeyPath(contract, model);
  const fields = typeof path === "string" ? [path] : path;
  const parts = typeof path === "string" ? [key] : key;
  if (!Array.isArray(parts) || parts.length !== fields.length) return undefined;
  const record = Object.fromEntries(fields.map((field, i) => [field, parts[i]]));
  return extractKeyFromRow(decodeJsonRecord(contract.domain, model, record), path);
}

/** Compare an event's persisted id without reviving JSON-flattened non-Decimal key parts. */
export function versionMetaMatches(contract: IdbContract, model: string, id: string, key: IDBValidKey): boolean {
  if (versionMetaKey(model, key) === id) return true;
  if (!hasDecimalPrimaryKey(contract, model) || !id.startsWith(`${model}::`)) return false;
  const storedKey: unknown = JSON.parse(id.slice(model.length + 2));
  const path = getKeyPath(contract, model);
  const fields = typeof path === "string" ? [path] : path;
  const parts = typeof path === "string" ? [key] : key;
  if (!Array.isArray(parts)) return false;
  const record = Object.fromEntries(fields.map((field, i) => [field, parts[i]]));
  const retained = preserveDecimalKeySpelling(contract, model, record, storedKey);
  return versionMetaKey(model, extractKeyFromRow(retained, path)) === id;
}
