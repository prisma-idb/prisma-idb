import type { LogWithRecordBody } from "./schemas";

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
export type LogWithRecord = LogWithRecordBody;

/**
 * Per-event result from the push endpoint. `retryable` (present only for
 * `success: false`) is the server's own verdict on whether trying again
 * could ever change the outcome — `markFailed` (outbox-store.ts) uses it to
 * decide whether to give up on this local change immediately.
 */
export interface PushResult {
  id: string;
  success: boolean;
  error?: string;
  retryable?: boolean;
  /**
   * Sent with a non-retryable failure: the row's current state on the
   * server, or `null` if it is deleted or not the caller's. The worker
   * replaces the rejected local write with it (see `reconcile-rejected.ts`).
   * Absent if the server could not read the row.
   */
  record?: Record<string, unknown> | null;
}

/** Stats returned by `applyPull`. */
export interface ApplyPullResult {
  applied: number;
  /** Rows not applied: already applied, invalid, for an unknown model, or the row the page halted at. Rows after a halt are not counted. */
  skipped: number;
  /** Subset of skipped: invalid decoded records, keys, or wire values. */
  validationFailed: number;
  /**
   * True if the page stopped early at a row that could not be applied yet: a
   * transaction failure or a pending local change. The next pull restarts at
   * that row.
   */
  halted: boolean;
  /**
   * The newest id the cursor may move to: the highest id among the rows
   * before any halt that were applied, already applied or invalid. `null` if
   * there is none, so the cursor must not move.
   */
  lastChangelogId: string | null;
}
