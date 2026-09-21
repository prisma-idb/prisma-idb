/**
 * One tracked mutation's outbox write — model, operation, resolved key (when
 * statically knowable), and the exact payload written to the outbox record.
 * Fired via `SyncIdbClient.on("outboxwrite", ...)`, batched per underlying
 * IDB write call: a single `create()`/`update()`/`delete()` fires with a
 * 1-element array; a batched write that resolves multiple rows in one call
 * (`createAll()`, a cascade delete's scan-write, `updateAll()`/`deleteAll()`)
 * fires once with all of them. See sync-executor.ts's `SyncInterceptorExecutor`
 * and `SyncInterceptingTransactionScope` for exactly which calls batch
 * together — it's "per IDB write call", not "per top-level ORM call": a
 * `deleteAll()` cascading across N parents still fires once per parent (plus
 * once per parent's own cascade batch), not once for the whole `deleteAll()`.
 */
export interface OutboxWriteEntry {
  readonly modelName: string;
  readonly operation: string;
  readonly key: unknown;
  readonly payload: unknown;
}

/** Outbox event record stored in `_idb_sync_outbox`. */
export interface OutboxEvent {
  id: string;
  entityType: string;
  operation: string;
  payload: unknown;
  createdAt: Date;
  synced: boolean;
  syncedAt: Date | null;
  lastAttemptedAt: Date | null;
  tries: number;
  lastError: string | null;
  retryable: boolean;
  /**
   * The `_idb_sync_version_meta` record id this event's mutation was keyed
   * under (same value as `versionMetaKey(modelName, key)`), or `null` when
   * the key couldn't be determined statically (scan-writes, upsert, bulk
   * ops — see `extractKey` in `sync-executor.ts`). `markSynced` reads this
   * back to clear `localChangePending` on the matching version-meta row.
   */
  versionMetaId: string | null;
}

/** Version-meta record stored in `_idb_sync_version_meta`. */
export interface VersionMetaRecord {
  id: string;
  model: string;
  key: unknown;
  lastAppliedChangeId: string | null;
  localChangePending: boolean;
}

/** Server changelog entry returned by the pull endpoint. */
export interface LogWithRecord {
  changelogId: string;
  model: string;
  operation: "create" | "update" | "delete";
  keyPath: unknown;
  record: Record<string, unknown> | null;
}

/**
 * Per-event result from the push endpoint. `retryable` (present only for
 * `success: false`) is the server's own verdict on whether trying again
 * could ever change the outcome — `markFailed` (outbox-store.ts) uses it to
 * decide whether to give up on this local change immediately rather than
 * waiting out the client-side retry cap.
 */
export interface PushResult {
  id: string;
  success: boolean;
  error?: string;
  retryable?: boolean;
}

/** Stats returned by `applyPull`. */
export interface ApplyPullResult {
  applied: number;
  skipped: number;
  lastChangelogId: string | null;
}
