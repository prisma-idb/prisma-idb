export { createSyncIdbClient } from "../core/sync-client";
export type { SyncIdbClient, SyncIdbClientOptions, SyncClientEventMap } from "../core/sync-client";

export { createAutoMigratingSyncIdbClient } from "../core/auto-migrate-sync";
export type { AutoMigratingSyncIdbClientOptions } from "../core/auto-migrate-sync";

export { createManagedAutoSyncIdbClient } from "../core/managed-auto-migrate-sync";

export { createSyncWorker } from "../core/sync-worker";
export type {
  SyncWorker,
  SyncWorkerOptions,
  SyncWorkerStatus,
  PushCompletedEvent,
  PullCompletedEvent,
} from "../core/sync-worker";

export { applyPull } from "../core/apply-pull";
export { getNextBatch, markSynced, markFailed } from "../core/outbox-store";

export type {
  OutboxEvent,
  OutboxWriteEntry,
  LogWithRecord,
  PushResult,
  ApplyPullResult,
  VersionMetaRecord,
} from "../types";
