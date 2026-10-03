/**
 * Identity of a `_idb_sync_version_meta` record. The sync executor writes it
 * when a local mutation is tracked, `applyPull` looks it up when a server
 * change arrives, and `markSynced` reads it back from `OutboxEvent.versionMetaId`
 * — all three must derive the same id for the same record.
 */

export const VERSION_META_STORE = "_idb_sync_version_meta";

/** The `_idb_sync_version_meta` id for the record of `modelName` stored under `key`. */
export function versionMetaKey(modelName: string, key: unknown): string {
  return `${modelName}::${JSON.stringify(key)}`;
}
