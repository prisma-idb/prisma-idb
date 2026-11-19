import CodeBlockWriter from "code-block-writer";
import {
  getUniqueIdentifiers,
  getNonUniqueIndexes,
  getForeignKeyIndexes,
  toCamelCase as toCamelCaseUtil,
} from "../../../helpers/utils";
import type { DMMF } from "@prisma/generator-helper";
import { shouldTrackModel } from "../../outbox/utils";
import { Model } from "../../types";

export function addClientClass(
  writer: CodeBlockWriter,
  models: readonly Model[],
  outboxSync: boolean,
  outboxModelName: string,
  versionMetaModelName: string,
  include: string[] = ["*"],
  exclude: string[] = [],
  indexes: readonly DMMF.Index[] = []
) {
  // Write type definition for CreateSyncWorkerOptions if sync is enabled
  if (outboxSync) {
    writer.writeLine(`type CreateSyncWorkerOptions =`);
    writer.block(() => {
      writer.writeLine(`push: {`);
      writer.indent(() => {
        writer.writeLine(`handler: (events: OutboxEventRecord[]) => Promise<PushResult[]>;`);
        writer.writeLine(`batchSize?: number;`);
      });
      writer.writeLine(`};`);
      writer.writeLine(`pull: {`);
      writer.indent(() => {
        writer.writeLine(`handler: (`);
        writer.indent(() => {
          writer.writeLine(`cursor?: string`);
        });
        writer.writeLine(
          `) => Promise<{ cursor?: string; logsWithRecords: LogWithStringifiedRecord<typeof validators>[] }>;`
        );
        writer.writeLine(`getCursor?: () => Promise<string | undefined> | string | undefined;`);
        writer.writeLine(`setCursor?: (cursor: string | undefined) => Promise<void> | void;`);
      });
      writer.writeLine(`};`);
      writer.writeLine(`schedule?: {`);
      writer.indent(() => {
        writer.writeLine(`intervalMs?: number;`);
        writer.writeLine(`backoffMs?: number;`);
      });
      writer.writeLine(`};`);
    });
    writer.blankLine();
  }

  writer.writeLine(`export class PrismaIDBClient`).block(() => {
    writer
      .writeLine(`private static instance: PrismaIDBClient;`)
      .writeLine(`_db!: IDBPDatabase<PrismaIDBSchema>;`)
      .writeLine(`private outboxEnabled: boolean = ${outboxSync};`)
      .writeLine(`private includedModels: Set<string>;`)
      .blankLine()
      .writeLine(`private constructor() {`)
      .writeLine(
        `this.includedModels = new Set(${JSON.stringify(models.filter((m) => shouldTrackModel(m.name, include, exclude)).map((m) => m.name))});`
      )
      .writeLine(`}`);

    addModelProperties(writer, models);
    addOutboxProperty(writer, outboxSync, outboxModelName, versionMetaModelName);
    addCreateInstanceMethod(writer);
    addResetDatabaseMethod(writer);
    addShouldTrackModelMethod(writer);
    if (outboxSync) {
      addCreateSyncWorkerMethod(writer);
    }
    addInitializeMethod(writer, models, outboxSync, outboxModelName, versionMetaModelName, indexes);
  });
}

function addModelProperties(writer: CodeBlockWriter, models: readonly Model[]) {
  models.forEach((model) => writer.writeLine(`${toCamelCaseUtil(model.name)}!: ${model.name}IDBClass;`));
}

function addOutboxProperty(
  writer: CodeBlockWriter,
  outboxSync: boolean,
  outboxModelName: string,
  versionMetaModelName: string
) {
  if (!outboxSync) return;
  writer
    .writeLine(`$outbox!: ${outboxModelName}IDBClass;`)
    .writeLine(`$versionMeta!: ${versionMetaModelName}IDBClass;`);
}

function addCreateInstanceMethod(writer: CodeBlockWriter) {
  writer.writeLine(`public static async createClient(): Promise<PrismaIDBClient>`).block(() => {
    writer
      .writeLine(`if (!PrismaIDBClient.instance)`)
      .block(() => {
        writer
          .writeLine(`const client = new PrismaIDBClient();`)
          .writeLine(`await client.initialize();`)
          .writeLine(`PrismaIDBClient.instance = client;`);
      })
      .writeLine(`return PrismaIDBClient.instance;`);
  });
}

function addInitializeMethod(
  writer: CodeBlockWriter,
  models: readonly Model[],
  outboxSync: boolean,
  outboxModelName: string,
  versionMetaModelName: string,
  indexes: readonly DMMF.Index[] = []
) {
  writer.writeLine(`private async initialize()`).block(() => {
    writer
      .writeLine(`this._db = await openDB<PrismaIDBSchema>("prisma-idb", IDB_VERSION, `)
      .block(() => {
        writer.writeLine(`upgrade(db) `).block(() => {
          models.forEach((model) => addObjectStoreInitialization(model, writer, indexes));
          if (outboxSync) {
            addOutboxObjectStoreInitialization(writer, outboxModelName);
            addVersionMetaInitialization(writer, versionMetaModelName);
          }
        });
      })
      .writeLine(`);`);

    models.forEach((model) => {
      writer.writeLine(
        `this.${toCamelCaseUtil(model.name)} = new ${model.name}IDBClass(this, ${getUniqueIdentifiers(model)[0].keyPath});`
      );
    });

    if (outboxSync) {
      writer.writeLine(`this.$outbox = new ${outboxModelName}IDBClass(this, ['id']);`);
      writer.writeLine(`this.$versionMeta = new ${versionMetaModelName}IDBClass(this, ['model', 'key']);`);
    }
  });
}

function addShouldTrackModelMethod(writer: CodeBlockWriter) {
  writer.writeLine(`shouldTrackModel(modelName: string): boolean`).block(() => {
    writer.writeLine(`return this.outboxEnabled && this.includedModels.has(modelName);`);
  });
}

function addCreateSyncWorkerMethod(writer: CodeBlockWriter) {
  writer
    .writeLine(`/**`)
    .writeLine(` * Create a sync worker for bi-directional synchronization with remote server.`)
    .writeLine(` *`)
    .writeLine(` * The worker implements a structured sync pattern:`)
    .writeLine(` * 1. **Push phase**: Drains all local events (outbox) to server until empty or abandoned`)
    .writeLine(` * 2. **Pull phase**: Fetches remote changes incrementally using cursor-based pagination`)
    .writeLine(` * 3. **Schedule**: Repeats cycles at fixed intervals with proper error handling`)
    .writeLine(` *`)
    .writeLine(` * @param options Sync configuration`)
    .writeLine(` * @param options.push Push handler configuration`)
    .writeLine(` * @param options.push.handler Function that receives batch of outbox events and returns sync results.`)
    .writeLine(` *   Should return PushResult[] with status for each event. Thrown errors are caught internally`)
    .writeLine(` *   and events are marked as failed with error message.`)
    .writeLine(` * @param options.push.batchSize Maximum events to process in one push batch (default: 10)`)
    .writeLine(` * @param options.pull Pull handler configuration`)
    .writeLine(` * @param options.pull.handler Function that fetches remote changes since cursor.`)
    .writeLine(` *   Must return { logsWithRecords, cursor } where cursor enables resumable pagination.`)
    .writeLine(` *   Thrown errors stop pull phase gracefully; will retry next cycle.`)
    .writeLine(` * @param options.pull.getCursor Optional handler to retrieve persisted pull cursor.`)
    .writeLine(` *   If not provided, starts from undefined (first page). Use this to resume from checkpoint.`)
    .writeLine(
      ` * @param options.pull.setCursor Optional handler to persist pull cursor after successful page processing.`
    )
    .writeLine(` *   Called only after logsWithRecords are successfully applied to local state.`)
    .writeLine(` * @param options.schedule Scheduling configuration`)
    .writeLine(` * @param options.schedule.intervalMs Milliseconds between sync cycles (default: 5000)`)
    .writeLine(
      ` * @param options.schedule.backoffMs Exponential backoff base duration in milliseconds (default: 30000 = 30 seconds).`
    )
    .writeLine(
      ` *   For each failed attempt, the wait time is calculated as: backoffMs * 2^(tries-1). E.g. with the default 30 seconds:`
    )
    .writeLine(` *   First failure: wait 30s, second: wait 60s, third: wait 120s, etc.`)
    .writeLine(` *`)
    .writeLine(` * @returns SyncWorker with start() and stop() methods`)
    .writeLine(` *`)
    .writeLine(` * @example`)
    .writeLine(` * const worker = client.createSyncWorker({`)
    .writeLine(` *   push: {`)
    .writeLine(` *     handler: async (events) => {`)
    .writeLine(` *       return await api.syncBatch(events);  // send to server`)
    .writeLine(` *     },`)
    .writeLine(` *     batchSize: 20`)
    .writeLine(` *   },`)
    .writeLine(` *   pull: {`)
    .writeLine(` *     handler: async (cursor) => {`)
    .writeLine(` *     },`)
    .writeLine(` *     getCursor: async () => {`)
    .writeLine(` *       const value = localStorage.getItem('syncCursor');`)
    .writeLine(` *       return value ?? undefined;`)
    .writeLine(` *     },`)
    .writeLine(` *     setCursor: async (cursor) => {`)
    .writeLine(` *       if (cursor !== undefined) {`)
    .writeLine(` *         localStorage.setItem('syncCursor', String(cursor));`)
    .writeLine(` *       } else {`)
    .writeLine(` *         localStorage.removeItem('syncCursor');`)
    .writeLine(` *       }`)
    .writeLine(` *     }`)
    .writeLine(` *   },`)
    .writeLine(` *   schedule: { intervalMs: 3000 }`)
    .writeLine(` * });`)
    .writeLine(` *`)
    .writeLine(` * worker.start();   // begins sync cycles`)
    .writeLine(` */`)
    .writeLine(`createSyncWorker(options: CreateSyncWorkerOptions): SyncWorker`)
    .block(() => {
      writer
        .writeLine(`const { push, pull } = options;`)
        .writeLine(`const { handler: pushHandler, batchSize = 10 } = push;`)
        .writeLine(`const { handler: pullHandler, getCursor, setCursor } = pull;`)
        .writeLine(`const { intervalMs = 5000, backoffMs = 30000 } = options.schedule || {};`)
        .blankLine()
        .writeLine(`let intervalId: ReturnType<typeof setInterval | typeof setTimeout> | null = null;`)
        .writeLine(`let status: 'STOPPED' | 'IDLE' | 'PUSHING' | 'PULLING' = 'STOPPED';`)
        .writeLine(`let stopRequested = false;`)
        .writeLine(`let isLooping = false;`)
        .writeLine(`let lastSyncTime: Date | null = null;`)
        .writeLine(`let lastError: Error | null = null;`)
        .writeLine(`const eventTarget = new EventTarget();`)
        .blankLine()
        .writeLine(`const emitStatusChange = () => {`)
        .writeLine(`  const detail = { status, isLooping, lastSyncTime, lastError };`)
        .writeLine(`  const event = new CustomEvent('statuschange', { detail });`)
        .writeLine(`  eventTarget.dispatchEvent(event);`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`const emitPullCompleted = (stats: ApplyPullResult) => {`)
        .writeLine(`  const event = new CustomEvent('pullcompleted', { detail: stats });`)
        .writeLine(`  eventTarget.dispatchEvent(event);`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`const emitPushCompleted = (results: PushResult[]) => {`)
        .writeLine(`  const event = new CustomEvent('pushcompleted', { detail: { results } });`)
        .writeLine(`  eventTarget.dispatchEvent(event);`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`let pullStats: ApplyPullResult =`)
        .block(() => {
          writer.writeLine(`validationErrors: [],`);
          writer.writeLine(`missingRecords: 0,`);
          writer.writeLine(`staleRecords: 0,`);
          writer.writeLine(`totalAppliedRecords: 0,`);
        })
        .blankLine()
        .writeLine(`/**`)
        .writeLine(` * Check if an event is ready to be retried based on exponential backoff.`)
        .writeLine(` * Returns true if enough time has passed since the last attempted push.`)
        .writeLine(` */`)
        .writeLine(`const isReadyToRetry = (event: OutboxEventRecord, overrideBackoff = false): boolean =>`)
        .block(() => {
          writer.writeLine(`if (!event.lastAttemptedAt) return true;`);
          writer.writeLine(`const now = Date.now();`);
          writer.writeLine(`const backoffMultiplier = overrideBackoff ? 0 : Math.pow(2, event.tries - 1);`);
          writer.writeLine(`const nextRetryTime = event.lastAttemptedAt.getTime() + (backoffMs * backoffMultiplier);`);
          writer.writeLine(`return now >= nextRetryTime;`);
        })
        .blankLine()
        .writeLine(`/**`)
        .writeLine(` * Process a batch of outbox events passed as argument.`)
        .writeLine(` * This is the core unit of push work, avoiding redundant fetches.`)
        .writeLine(` */`)
        .writeLine(
          `const pushBatch = async (batch: OutboxEventRecord[], overrideBackoff = false): Promise<PushResult[]> => {`
        )
        .writeLine(`  // Only push retryable events; do not mark as permanently failed on client`)
        .writeLine(
          `  const toSync = batch.filter((event: OutboxEventRecord) => event.retryable && isReadyToRetry(event, overrideBackoff));`
        )
        .writeLine(`  if (toSync.length === 0) return [];`)
        .writeLine(`  let results: PushResult[];`)
        .writeLine(`  try {`)
        .writeLine(`    results = await pushHandler(toSync);`)
        .writeLine(`  } catch (err) {`)
        .writeLine(`    for (const event of toSync) {`)
        .writeLine(`      const error = err instanceof Error ? err.message : String(err);`)
        .writeLine(
          `      await this.$outbox.markFailed(event.id, { type: "UNKNOWN_ERROR", message: error, retryable: true });`
        )
        .writeLine(`    }`)
        .writeLine(`    throw err;`)
        .writeLine(`  }`)
        .writeLine(`  const appliedLogs: { id: string; lastAppliedChangeId: string | null }[] = [];`)
        .writeLine(`  for (const result of results) {`)
        .writeLine(`    if (result.error) {`)
        .writeLine(`      // Only the server can mark retryable = false`)
        .writeLine(`      await this.$outbox.markFailed(result.id, result.error);`)
        .writeLine(`    } else {`)
        .writeLine(`      appliedLogs.push({ id: result.id, lastAppliedChangeId: result.appliedChangelogId });`)
        .writeLine(`    }`)
        .writeLine(`  }`)
        .writeLine(`  if (appliedLogs.length > 0) {`)
        .writeLine(`    await this.$outbox.markSynced(appliedLogs);`)
        .writeLine(`  }`)
        .writeLine(`  return results;`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`/**`)
        .writeLine(` * Drain the push phase: keep pushing batches until outbox is empty`)
        .writeLine(` * or all remaining events are abandoned (unrecoverable).`)
        .writeLine(` *`)
        .writeLine(` * Invariant: when this completes, there are no syncable events left.`)
        .writeLine(` */`)
        .writeLine(`const drainPushPhase = async (overrideBackoff = false): Promise<void> => {`)
        .writeLine(`  status = 'PUSHING';`)
        .writeLine(`  emitStatusChange();`)
        .writeLine(`  try {`)
        .writeLine(`    const allResults: PushResult[] = [];`)
        .writeLine(`    while (true) {`)
        .writeLine(`      const batch = await this.$outbox.getNextBatch({ limit: batchSize });`)
        .writeLine(`      if (batch.length === 0) break;`)
        .writeLine(
          `      const ready = batch.filter(event => event.retryable && isReadyToRetry(event, overrideBackoff));`
        )
        .writeLine(`      if (ready.length === 0) break;`)
        .writeLine(`      const batchResults = await pushBatch(ready, overrideBackoff);`)
        .writeLine(`      if (batchResults && batchResults.length > 0) allResults.push(...batchResults);`)
        .writeLine(`    }`)
        .writeLine(`    // Emit push results after push drained`)
        .writeLine(`    try {`)
        .writeLine(`      emitPushCompleted(allResults);`)
        .writeLine(`    } catch (err) {`)
        .writeLine(`      console.warn('Failed to emit pushcompleted event:', err);`)
        .writeLine(`    }`)
        .writeLine(`  } catch (err) {`)
        .writeLine(`    const errorMessage = err instanceof Error ? err.message : String(err);`)
        .writeLine(`    console.error('Push phase failed:', errorMessage);`)
        .writeLine(`    throw err;`)
        .writeLine(`  }`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`/**`)
        .writeLine(` * Drain the pull phase: keep pulling pages until no more data is available.`)
        .writeLine(` *`)
        .writeLine(` * Rules:`)
        .writeLine(` * - Only executes after push phase completes`)
        .writeLine(` * - Never writes to outbox`)
        .writeLine(` * - Uses optional cursor state handlers provided by user`)
        .writeLine(` * - Handles errors gracefully, stops pull on failure`)
        .writeLine(` */`)
        .writeLine(`const drainPullPhase = async (): Promise<void> => {`)
        .writeLine(`  status = 'PULLING';`)
        .writeLine(`  emitStatusChange();`)
        .writeLine(`  try {`)
        .writeLine(`    let cursor = getCursor ? await Promise.resolve(getCursor()) : undefined;`)
        .writeLine(
          `    pullStats = { validationErrors: [], missingRecords: 0, staleRecords: 0, totalAppliedRecords: 0 };`
        )
        .blankLine()
        .writeLine(`    while (true) {`)
        .writeLine(`      const res = await pullHandler(cursor);`)
        .writeLine(`      const { logsWithRecords, cursor: nextCursor } = res;`)
        .writeLine(`      if (logsWithRecords.length === 0) break;`)
        .blankLine()
        .writeLine(`      const pageStats = await applyPull({ idbClient: this, logsWithRecords });`)
        .writeLine(`      pullStats.totalAppliedRecords += pageStats.totalAppliedRecords;`)
        .writeLine(`      pullStats.missingRecords += pageStats.missingRecords;`)
        .writeLine(`      pullStats.staleRecords += pageStats.staleRecords;`)
        .writeLine(`      pullStats.validationErrors.push(...pageStats.validationErrors);`)
        .blankLine()
        .writeLine(`      if (setCursor) {`)
        .writeLine(`        await Promise.resolve(setCursor(nextCursor));`)
        .writeLine(`      }`)
        .blankLine()
        .writeLine(`      cursor = nextCursor;`)
        .writeLine(`      if (typeof cursor !== 'string') break;`)
        .writeLine(`    }`)
        .blankLine()
        .writeLine(`    emitPullCompleted(pullStats);`)
        .writeLine(`  } catch (err) {`)
        .writeLine(`    const errorMessage = err instanceof Error ? err.message : String(err);`)
        .writeLine(`    console.error('Pull phase failed:', errorMessage);`)
        .writeLine(`    throw err;`)
        .writeLine(`  }`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`/**`)
        .writeLine(` * Execute one complete sync cycle:`)
        .writeLine(` * 1. Drain push phase (all local events → server)`)
        .writeLine(` * 2. Drain pull phase (server state → local)`)
        .writeLine(` *`)
        .writeLine(` * Guarantees:`)
        .writeLine(` * - No overlapping sync cycles (guarded by isProcessing)`)
        .writeLine(` * - Push fully completes before pull starts`)
        .writeLine(` * - Order is unbreakable`)
        .writeLine(` */`)
        .writeLine(`const syncOnce = async (overrideBackoff = false): Promise<void> => {`)
        .writeLine(`  if (status === 'PUSHING' || status === 'PULLING') {`)
        .writeLine(`    console.warn('syncOnce: sync already in progress');`)
        .writeLine(`    return;`)
        .writeLine(`  }`)
        .blankLine()
        .writeLine(`  try {`)
        .writeLine(`    // Check for any retryable unsynced outbox events`)
        .writeLine(`    const hasRetryable = await this.$outbox.hasAnyRetryableUnsynced();`)
        .writeLine(`    if (hasRetryable) {`)
        .writeLine(`      await drainPushPhase(overrideBackoff);`)
        .writeLine(`      // After push, check again; if still retryable, do not pull`)
        .writeLine(`      const stillHasRetryable = await this.$outbox.hasAnyRetryableUnsynced();`)
        .writeLine(`      if (stillHasRetryable) {`)
        .writeLine(`        // Only push, skip pull`)
        .writeLine(`        return;`)
        .writeLine(`      }`)
        .writeLine(`    }`)
        .writeLine(`    // Only pull if no retryable unsynced events`)
        .writeLine(`    await drainPullPhase();`)
        .writeLine(`    lastSyncTime = new Date();`)
        .writeLine(`    lastError = null;`)
        .writeLine(`  } catch (err) {`)
        .writeLine(`    lastError = err instanceof Error ? err : new Error(String(err));`)
        .writeLine(`    console.error('Sync cycle failed:', err);`)
        .writeLine(`    emitStatusChange();`)
        .writeLine(`  } finally {`)
        .writeLine(`    status = isLooping ? 'IDLE' : 'STOPPED';`)
        .writeLine(`    emitStatusChange();`)
        .writeLine(`    if (isLooping && !stopRequested) {`)
        .writeLine(`      intervalId = setTimeout(() => syncOnce(), intervalMs);`)
        .writeLine(`    }`)
        .writeLine(`  }`)
        .writeLine(`};`)
        .blankLine()
        .writeLine(`return {`)
        .writeLine(`  /**`)
        .writeLine(`   * Start the sync worker.`)
        .writeLine(`   * Begins sync cycles at the configured interval.`)
        .writeLine(`   * Does nothing if already running.`)
        .writeLine(`   */`)
        .writeLine(`  start(): void {`)
        .writeLine(`    if (isLooping) {`)
        .writeLine(`      console.warn('start: worker is already running');`)
        .writeLine(`      return;`)
        .writeLine(`    }`)
        .writeLine(`    stopRequested = false;`)
        .writeLine(`    isLooping = true;`)
        .writeLine(`    syncOnce()`)
        .writeLine(`  },`)
        .blankLine()
        .writeLine(`  /**`)
        .writeLine(`   * Stop the sync worker.`)
        .writeLine(`   * Stops scheduling new sync cycles.`)
        .writeLine(`   * Any in-progress sync will complete before fully stopping.`)
        .writeLine(`   */`)
        .writeLine(`  stop(): void {`)
        .writeLine(`    stopRequested = true;`)
        .writeLine(`    isLooping = false;`)
        .writeLine(`    if (intervalId !== null) {`)
        .writeLine(`      clearTimeout(intervalId);`)
        .writeLine(`      intervalId = null;`)
        .writeLine(`    }`)
        .writeLine(`    if (status === 'IDLE') {`)
        .writeLine(`      status = 'STOPPED';`)
        .writeLine(`      emitStatusChange();`)
        .writeLine(`    }`)
        .writeLine(`  },`)
        .blankLine()
        .writeLine(`  /**`)
        .writeLine(`   * Force an immediate sync cycle while worker is running.`)
        .writeLine(`   * Returns immediately if worker is stopped or a sync is already in progress.`)
        .writeLine(`   * Use syncNow() to trigger a one-off sync without starting the worker.`)
        .writeLine(`   */`)
        .writeLine(`  async forceSync(options?: { overrideBackoff?: boolean }): Promise<void> {`)
        .writeLine(`    if (!isLooping) {`)
        .writeLine(`      console.warn('forceSync: worker is not running');`)
        .writeLine(`      return;`)
        .writeLine(`    }`)
        .writeLine(`    if (status === 'PUSHING' || status === 'PULLING') {`)
        .writeLine(`      console.warn(\`forceSync: sync already in progress: \${status}\`);`)
        .writeLine(`      return;`)
        .writeLine(`    }`)
        .writeLine(`    if (intervalId) clearTimeout(intervalId);`)
        .writeLine(`    await syncOnce(options?.overrideBackoff);`)
        .writeLine(`  },`)
        .blankLine()
        .writeLine(`  /**`)
        .writeLine(`   * Execute a single sync cycle immediately without starting the worker.`)
        .writeLine(`   * Returns immediately if a sync is already in progress.`)
        .writeLine(`   * Does not require the worker to be running (started).`)
        .writeLine(`   */`)
        .writeLine(`  async syncNow(options?: { overrideBackoff?: boolean }): Promise<void> {`)
        .writeLine(`    const isRunning = status === 'PUSHING' || status === 'PULLING';`)
        .writeLine(`    if (isRunning) {`)
        .writeLine(`      console.warn('syncNow: sync already in progress');`)
        .writeLine(`      return;`)
        .writeLine(`    }`)
        .writeLine(`    if (intervalId) clearTimeout(intervalId);`)
        .writeLine(`    await syncOnce(options?.overrideBackoff);`)
        .writeLine(`  },`)
        .blankLine()
        .writeLine(`  /**`)
        .writeLine(`   * Get current sync worker status.`)
        .writeLine(`   * The status object contains plain values that do not auto-update.`)
        .writeLine(`   * Frameworks will not automatically track changes; consumers must poll`)
        .writeLine(`   * worker.status or subscribe via worker.on('statuschange', ...) to receive updates.`)
        .writeLine(`   */`)
        .writeLine(`  get status() {`)
        .writeLine(`    return {`)
        .writeLine(`      /** Current status of the sync worker */`)
        .writeLine(`      status,`)
        .writeLine(`      /** Whether the sync worker is looping */`)
        .writeLine(`      isLooping,`)
        .writeLine(`      /** Timestamp of the last successful sync completion */`)
        .writeLine(`      lastSyncTime,`)
        .writeLine(`      /** The last error encountered during sync, if any */`)
        .writeLine(`      lastError,`)
        .writeLine(`    };`)
        .writeLine(`  },`)
        .blankLine()
        .writeLine(`  /**`)
        .writeLine(`   * Listen for status changes, pull completion, or push completion events.`)
        .writeLine(`   * @returns Unsubscribe function`)
        .writeLine(`   */`)
        .writeLine(`  on<E extends "statuschange" | "pullcompleted" | "pushcompleted">(`)
        .writeLine(`    event: E,`)
        .writeLine(`    callback: (`)
        .writeLine(`      e: E extends "statuschange"`)
        .writeLine(
          `        ? CustomEvent<{ status: 'STOPPED' | 'IDLE' | 'PUSHING' | 'PULLING'; isLooping: boolean; lastSyncTime: Date | null; lastError: Error | null }>`
        )
        .writeLine(`        : E extends "pullcompleted"`)
        .writeLine(`        ? CustomEvent<ApplyPullResult>`)
        .writeLine(`        : CustomEvent<{ results: PushResult[] }>`)
        .writeLine(`    ) => void`)
        .writeLine(`  ): () => void {`)
        .writeLine(`    // eslint-disable-next-line @typescript-eslint/no-explicit-any`)
        .writeLine(`    const listener = (e: Event) => callback(e as any);`)
        .writeLine(`    eventTarget.addEventListener(event, listener as EventListener);`)
        .writeLine(`    return () => eventTarget.removeEventListener(event, listener as EventListener);`)
        .writeLine(`  }`)
        .writeLine(`};`);
    });
}

function addObjectStoreInitialization(model: Model, writer: CodeBlockWriter, indexes: readonly DMMF.Index[] = []) {
  const nonKeyUniqueIdentifiers = getUniqueIdentifiers(model).slice(1);
  const nonUniqueIndexes = getNonUniqueIndexes(model, indexes);
  const fkIndexes = getForeignKeyIndexes(model, indexes);
  const allNonUniqueIndexes = [...nonUniqueIndexes, ...fkIndexes];
  const keyPath = getUniqueIdentifiers(model)[0].keyPath;
  const hasAnyIndexes = nonKeyUniqueIdentifiers.length > 0 || allNonUniqueIndexes.length > 0;

  let declarationLine = hasAnyIndexes ? `const ${model.name}Store = ` : ``;
  declarationLine += `db.createObjectStore('${model.name}', { keyPath: ${keyPath} });`;

  writer.writeLine(declarationLine);
  nonKeyUniqueIdentifiers.forEach(({ name, keyPath }) =>
    writer.writeLine(`${model.name}Store.createIndex("${name}Index", ${keyPath}, { unique: true });`)
  );
  allNonUniqueIndexes.forEach(({ name, keyPath }) =>
    writer.writeLine(`${model.name}Store.createIndex("${name}Index", ${keyPath}, { unique: false });`)
  );
}

function addOutboxObjectStoreInitialization(writer: CodeBlockWriter, outboxModelName: string) {
  writer.writeLine(`db.createObjectStore('${outboxModelName}', { keyPath: ['id'] });`);
}

function addVersionMetaInitialization(writer: CodeBlockWriter, versionMetaModelName: string = "VersionMeta") {
  writer.writeLine(`db.createObjectStore('${versionMetaModelName}', { keyPath: ['model', 'key'] });`);
}

function addResetDatabaseMethod(writer: CodeBlockWriter) {
  writer.writeLine(`public async resetDatabase()`).block(() => {
    writer.writeLine(`if (!globalThis.indexedDB) throw new Error("IndexedDB is not available in this environment");`);
    writer.writeLine(`this._db.close();`);
    writer.write(`try `).block(() => {
      writer
        .write(`await new Promise<void>((resolve, reject) => `)
        .block(() => {
          writer
            .writeLine(`const req = globalThis.indexedDB.deleteDatabase("prisma-idb");`)
            .writeLine(`req.onsuccess = () => resolve();`)
            .writeLine(`req.onerror = () => reject(req.error);`);
          writer
            .write(`req.onblocked = () =>`)
            .block(() => {})
            .write(";");
        })
        .writeLine(");");
    });
    writer.write(`catch (e) `).block(() => {
      writer.writeLine(`await PrismaIDBClient.instance.initialize();`).writeLine(`throw e;`);
    });
    writer.writeLine(`await PrismaIDBClient.instance.initialize();`);
  });
}
