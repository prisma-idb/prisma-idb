/* eslint-disable @typescript-eslint/no-unused-vars */
import { openDB } from "idb";
import type { IDBPDatabase, StoreNames, IDBPTransaction } from "idb";
import type { Prisma } from "./generated/client";
import * as IDBUtils from "./idb-utils";
import type {
  OutboxEventRecord,
  ChangeMetaRecord,
  PrismaIDBSchema,
  SyncWorkerOptions,
  SyncWorker,
  IDBValidKey,
} from "./idb-interface";
import type { PushResult } from "../server/batch-processor";
import { validators, keyPathValidators, modelRecordToKeyPath } from "../validators";
import type { LogWithStringifiedRecord } from "../server/batch-processor";
import { applyPull, type ApplyPullResult } from "./apply-pull";
import { v4 as uuidv4 } from "uuid";
const IDB_VERSION = 1;
type CreateSyncWorkerOptions = {
  push: {
    handler: (events: OutboxEventRecord[]) => Promise<PushResult[]>;
    batchSize?: number;
  };
  pull: {
    handler: (
      cursor?: string
    ) => Promise<{ cursor?: string; logsWithRecords: LogWithStringifiedRecord<typeof validators>[] }>;
    getCursor?: () => Promise<string | undefined> | string | undefined;
    setCursor?: (cursor: string | undefined) => Promise<void> | void;
  };
  schedule?: {
    intervalMs?: number;
    backoffMs?: number;
  };
};

export class PrismaIDBClient {
  private static instance: PrismaIDBClient;
  _db!: IDBPDatabase<PrismaIDBSchema>;
  private outboxEnabled: boolean = true;
  private includedModels: Set<string>;

  private constructor() {
    this.includedModels = new Set(["Board", "Todo", "User"]);
  }
  board!: BoardIDBClass;
  todo!: TodoIDBClass;
  user!: UserIDBClass;
  $outbox!: OutboxEventIDBClass;
  $versionMeta!: VersionMetaIDBClass;
  public static async createClient(): Promise<PrismaIDBClient> {
    if (!PrismaIDBClient.instance) {
      const client = new PrismaIDBClient();
      await client.initialize();
      PrismaIDBClient.instance = client;
    }
    return PrismaIDBClient.instance;
  }
  public async resetDatabase() {
    if (!globalThis.indexedDB) throw new Error("IndexedDB is not available in this environment");
    this._db.close();
    try {
      await new Promise<void>((resolve, reject) => {
        const req = globalThis.indexedDB.deleteDatabase("prisma-idb");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => {};
      });
    } catch (e) {
      await PrismaIDBClient.instance.initialize();
      throw e;
    }
    await PrismaIDBClient.instance.initialize();
  }
  shouldTrackModel(modelName: string): boolean {
    return this.outboxEnabled && this.includedModels.has(modelName);
  }
  /**
   * Create a sync worker for bi-directional synchronization with remote server.
   *
   * The worker implements a structured sync pattern:
   * 1. **Push phase**: Drains all local events (outbox) to server until empty or abandoned
   * 2. **Pull phase**: Fetches remote changes incrementally using cursor-based pagination
   * 3. **Schedule**: Repeats cycles at fixed intervals with proper error handling
   *
   * @param options Sync configuration
   * @param options.push Push handler configuration
   * @param options.push.handler Function that receives batch of outbox events and returns sync results.
   *   Should return PushResult[] with status for each event. Thrown errors are caught internally
   *   and events are marked as failed with error message.
   * @param options.push.batchSize Maximum events to process in one push batch (default: 10)
   * @param options.pull Pull handler configuration
   * @param options.pull.handler Function that fetches remote changes since cursor.
   *   Must return { logsWithRecords, cursor } where cursor enables resumable pagination.
   *   Thrown errors stop pull phase gracefully; will retry next cycle.
   * @param options.pull.getCursor Optional handler to retrieve persisted pull cursor.
   *   If not provided, starts from undefined (first page). Use this to resume from checkpoint.
   * @param options.pull.setCursor Optional handler to persist pull cursor after successful page processing.
   *   Called only after logsWithRecords are successfully applied to local state.
   * @param options.schedule Scheduling configuration
   * @param options.schedule.intervalMs Milliseconds between sync cycles (default: 5000)
   * @param options.schedule.backoffMs Exponential backoff base duration in milliseconds (default: 30000 = 30 seconds).
   *   For each failed attempt, the wait time is calculated as: backoffMs * 2^(tries-1). E.g. with the default 30 seconds:
   *   First failure: wait 30s, second: wait 60s, third: wait 120s, etc.
   *
   * @returns SyncWorker with start() and stop() methods
   *
   * @example
   * const worker = client.createSyncWorker({
   *   push: {
   *     handler: async (events) => {
   *       return await api.syncBatch(events);  // send to server
   *     },
   *     batchSize: 20
   *   },
   *   pull: {
   *     handler: async (cursor) => {
   *     },
   *     getCursor: async () => {
   *       const value = localStorage.getItem('syncCursor');
   *       return value ?? undefined;
   *     },
   *     setCursor: async (cursor) => {
   *       if (cursor !== undefined) {
   *         localStorage.setItem('syncCursor', String(cursor));
   *       } else {
   *         localStorage.removeItem('syncCursor');
   *       }
   *     }
   *   },
   *   schedule: { intervalMs: 3000 }
   * });
   *
   * worker.start();   // begins sync cycles
   */
  createSyncWorker(options: CreateSyncWorkerOptions): SyncWorker {
    const { push, pull } = options;
    const { handler: pushHandler, batchSize = 10 } = push;
    const { handler: pullHandler, getCursor, setCursor } = pull;
    const { intervalMs = 5000, backoffMs = 30000 } = options.schedule || {};

    let intervalId: ReturnType<typeof setInterval | typeof setTimeout> | null = null;
    let status: "STOPPED" | "IDLE" | "PUSHING" | "PULLING" = "STOPPED";
    let stopRequested = false;
    let isLooping = false;
    let lastSyncTime: Date | null = null;
    let lastError: Error | null = null;
    const eventTarget = new EventTarget();

    const emitStatusChange = () => {
      const detail = { status, isLooping, lastSyncTime, lastError };
      const event = new CustomEvent("statuschange", { detail });
      eventTarget.dispatchEvent(event);
    };

    const emitPullCompleted = (stats: ApplyPullResult) => {
      const event = new CustomEvent("pullcompleted", { detail: stats });
      eventTarget.dispatchEvent(event);
    };

    const emitPushCompleted = (results: PushResult[]) => {
      const event = new CustomEvent("pushcompleted", { detail: { results } });
      eventTarget.dispatchEvent(event);
    };

    let pullStats: ApplyPullResult = {
      validationErrors: [],
      missingRecords: 0,
      staleRecords: 0,
      totalAppliedRecords: 0,
    };

    /**
     * Check if an event is ready to be retried based on exponential backoff.
     * Returns true if enough time has passed since the last attempted push.
     */
    const isReadyToRetry = (event: OutboxEventRecord, overrideBackoff = false): boolean => {
      if (!event.lastAttemptedAt) return true;
      const now = Date.now();
      const backoffMultiplier = overrideBackoff ? 0 : Math.pow(2, event.tries - 1);
      const nextRetryTime = event.lastAttemptedAt.getTime() + backoffMs * backoffMultiplier;
      return now >= nextRetryTime;
    };

    /**
     * Process a batch of outbox events passed as argument.
     * This is the core unit of push work, avoiding redundant fetches.
     */
    const pushBatch = async (batch: OutboxEventRecord[], overrideBackoff = false): Promise<PushResult[]> => {
      // Only push retryable events; do not mark as permanently failed on client
      const toSync = batch.filter(
        (event: OutboxEventRecord) => event.retryable && isReadyToRetry(event, overrideBackoff)
      );
      if (toSync.length === 0) return [];
      let results: PushResult[] = [];
      try {
        results = await pushHandler(toSync);
      } catch (err) {
        for (const event of toSync) {
          const error = err instanceof Error ? err.message : String(err);
          await this.$outbox.markFailed(event.id, { type: "UNKNOWN_ERROR", message: error, retryable: true });
        }
        throw err;
      }
      const appliedLogs: { id: string; lastAppliedChangeId: string | null }[] = [];
      for (const result of results) {
        if (result.error) {
          // Only the server can mark retryable = false
          await this.$outbox.markFailed(result.id, result.error);
        } else {
          appliedLogs.push({ id: result.id, lastAppliedChangeId: result.appliedChangelogId });
        }
      }
      if (appliedLogs.length > 0) {
        await this.$outbox.markSynced(appliedLogs);
      }
      return results;
    };

    /**
     * Drain the push phase: keep pushing batches until outbox is empty
     * or all remaining events are abandoned (unrecoverable).
     *
     * Invariant: when this completes, there are no syncable events left.
     */
    const drainPushPhase = async (overrideBackoff = false): Promise<void> => {
      status = "PUSHING";
      emitStatusChange();
      try {
        const allResults: PushResult[] = [];
        while (true) {
          const batch = await this.$outbox.getNextBatch({ limit: batchSize });
          if (batch.length === 0) break;
          const ready = batch.filter((event) => event.retryable && isReadyToRetry(event, overrideBackoff));
          if (ready.length === 0) break;
          const batchResults = await pushBatch(ready, overrideBackoff);
          if (batchResults && batchResults.length > 0) allResults.push(...batchResults);
        }
        // Emit push results after push drained
        try {
          emitPushCompleted(allResults);
        } catch (err) {
          console.warn("Failed to emit pushcompleted event:", err);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Push phase failed:", errorMessage);
        throw err;
      }
    };

    /**
     * Drain the pull phase: keep pulling pages until no more data is available.
     *
     * Rules:
     * - Only executes after push phase completes
     * - Never writes to outbox
     * - Uses optional cursor state handlers provided by user
     * - Handles errors gracefully, stops pull on failure
     */
    const drainPullPhase = async (): Promise<void> => {
      status = "PULLING";
      emitStatusChange();
      try {
        let cursor = getCursor ? await Promise.resolve(getCursor()) : undefined;
        pullStats = { validationErrors: [], missingRecords: 0, staleRecords: 0, totalAppliedRecords: 0 };

        while (true) {
          const res = await pullHandler(cursor);
          const { logsWithRecords, cursor: nextCursor } = res;
          if (logsWithRecords.length === 0) break;

          const pageStats = await applyPull({ idbClient: this, logsWithRecords });
          pullStats.totalAppliedRecords += pageStats.totalAppliedRecords;
          pullStats.missingRecords += pageStats.missingRecords;
          pullStats.staleRecords += pageStats.staleRecords;
          pullStats.validationErrors.push(...pageStats.validationErrors);

          if (setCursor) {
            await Promise.resolve(setCursor(nextCursor));
          }

          cursor = nextCursor;
          if (typeof cursor !== "string") break;
        }

        emitPullCompleted(pullStats);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Pull phase failed:", errorMessage);
        throw err;
      }
    };

    /**
     * Execute one complete sync cycle:
     * 1. Drain push phase (all local events → server)
     * 2. Drain pull phase (server state → local)
     *
     * Guarantees:
     * - No overlapping sync cycles (guarded by isProcessing)
     * - Push fully completes before pull starts
     * - Order is unbreakable
     */
    const syncOnce = async (overrideBackoff = false): Promise<void> => {
      if (status === "PUSHING" || status === "PULLING") {
        console.warn("syncOnce: sync already in progress");
        return;
      }

      try {
        // Check for any retryable unsynced outbox events
        const hasRetryable = await this.$outbox.hasAnyRetryableUnsynced();
        if (hasRetryable) {
          await drainPushPhase(overrideBackoff);
          // After push, check again; if still retryable, do not pull
          const stillHasRetryable = await this.$outbox.hasAnyRetryableUnsynced();
          if (stillHasRetryable) {
            // Only push, skip pull
            return;
          }
        }
        // Only pull if no retryable unsynced events
        await drainPullPhase();
        lastSyncTime = new Date();
        lastError = null;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error("Sync cycle failed:", err);
        emitStatusChange();
      } finally {
        status = isLooping ? "IDLE" : "STOPPED";
        emitStatusChange();
        if (isLooping && !stopRequested) {
          intervalId = setTimeout(() => syncOnce(), intervalMs);
        }
      }
    };

    return {
      /**
       * Start the sync worker.
       * Begins sync cycles at the configured interval.
       * Does nothing if already running.
       */
      start(): void {
        if (isLooping) {
          console.warn("start: worker is already running");
          return;
        }
        stopRequested = false;
        isLooping = true;
        syncOnce();
      },

      /**
       * Stop the sync worker.
       * Stops scheduling new sync cycles.
       * Any in-progress sync will complete before fully stopping.
       */
      stop(): void {
        stopRequested = true;
        isLooping = false;
        if (intervalId !== null) {
          clearTimeout(intervalId);
          intervalId = null;
        }
        if (status === "IDLE") {
          status = "STOPPED";
          emitStatusChange();
        }
      },

      /**
       * Force an immediate sync cycle while worker is running.
       * Returns immediately if worker is stopped or a sync is already in progress.
       * Use syncNow() to trigger a one-off sync without starting the worker.
       */
      async forceSync(options?: { overrideBackoff?: boolean }): Promise<void> {
        if (!isLooping) {
          console.warn("forceSync: worker is not running");
          return;
        }
        if (status === "PUSHING" || status === "PULLING") {
          console.warn(`forceSync: sync already in progress: ${status}`);
          return;
        }
        if (intervalId) clearTimeout(intervalId);
        await syncOnce(options?.overrideBackoff);
      },

      /**
       * Execute a single sync cycle immediately without starting the worker.
       * Returns immediately if a sync is already in progress.
       * Does not require the worker to be running (started).
       */
      async syncNow(options?: { overrideBackoff?: boolean }): Promise<void> {
        const isRunning = status === "PUSHING" || status === "PULLING";
        if (isRunning) {
          console.warn("syncNow: sync already in progress");
          return;
        }
        if (intervalId) clearTimeout(intervalId);
        await syncOnce(options?.overrideBackoff);
      },

      /**
       * Get current sync worker status.
       * The status object contains plain values that do not auto-update.
       * Frameworks will not automatically track changes; consumers must poll
       * worker.status or subscribe via worker.on('statuschange', ...) to receive updates.
       */
      get status() {
        return {
          /** Current status of the sync worker */
          status,
          /** Whether the sync worker is looping */
          isLooping,
          /** Timestamp of the last successful sync completion */
          lastSyncTime,
          /** The last error encountered during sync, if any */
          lastError,
        };
      },

      /**
       * Listen for status changes, pull completion, or push completion events.
       * @returns Unsubscribe function
       */
      on<E extends "statuschange" | "pullcompleted" | "pushcompleted">(
        event: E,
        callback: (
          e: E extends "statuschange"
            ? CustomEvent<{
                status: "STOPPED" | "IDLE" | "PUSHING" | "PULLING";
                isLooping: boolean;
                lastSyncTime: Date | null;
                lastError: Error | null;
              }>
            : E extends "pullcompleted"
              ? CustomEvent<ApplyPullResult>
              : CustomEvent<{ results: PushResult[] }>
        ) => void
      ): () => void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const listener = (e: Event) => callback(e as any);
        eventTarget.addEventListener(event, listener as EventListener);
        return () => eventTarget.removeEventListener(event, listener as EventListener);
      },
    };
  }
  private async initialize() {
    this._db = await openDB<PrismaIDBSchema>("prisma-idb", IDB_VERSION, {
      upgrade(db) {
        const BoardStore = db.createObjectStore("Board", { keyPath: ["id"] });
        BoardStore.createIndex("userIdIndex", ["userId"], { unique: false });
        const TodoStore = db.createObjectStore("Todo", { keyPath: ["id"] });
        TodoStore.createIndex("boardIdIndex", ["boardId"], { unique: false });
        const UserStore = db.createObjectStore("User", { keyPath: ["id"] });
        UserStore.createIndex("emailIndex", ["email"], { unique: true });
        db.createObjectStore("OutboxEvent", { keyPath: ["id"] });
        db.createObjectStore("VersionMeta", { keyPath: ["model", "key"] });
      },
    });
    this.board = new BoardIDBClass(this, ["id"]);
    this.todo = new TodoIDBClass(this, ["id"]);
    this.user = new UserIDBClass(this, ["id"]);
    this.$outbox = new OutboxEventIDBClass(this, ["id"]);
    this.$versionMeta = new VersionMetaIDBClass(this, ["model", "key"]);
  }
}
class BaseIDBModelClass<T extends keyof PrismaIDBSchema> {
  protected client: PrismaIDBClient;
  protected keyPath: string[];
  protected modelName: string;
  private eventEmitter: EventTarget;

  constructor(client: PrismaIDBClient, keyPath: string[], modelName: string) {
    this.client = client;
    this.keyPath = keyPath;
    this.modelName = modelName;
    this.eventEmitter = new EventTarget();
  }
  subscribe(
    event: "create" | "update" | "delete" | ("create" | "update" | "delete")[],
    callback: (e: CustomEvent<{ keyPath: PrismaIDBSchema[T]["key"]; oldKeyPath?: PrismaIDBSchema[T]["key"] }>) => void
  ): () => void {
    if (Array.isArray(event)) {
      event.forEach((evt) => this.eventEmitter.addEventListener(evt, callback as EventListener));
      return () => {
        event.forEach((evt) => this.eventEmitter.removeEventListener(evt, callback as EventListener));
      };
    }
    this.eventEmitter.addEventListener(event, callback as EventListener);
    return () => {
      this.eventEmitter.removeEventListener(event, callback as EventListener);
    };
  }
  protected async emit(
    event: "create" | "update" | "delete",
    keyPath: PrismaIDBSchema[T]["key"],
    oldKeyPath?: PrismaIDBSchema[T]["key"],
    record?: unknown,
    opts?: { silent?: boolean; addToOutbox?: boolean; tx?: IDBUtils.ReadwriteTransactionType }
  ) {
    const shouldEmit = !opts?.silent;

    if (shouldEmit) {
      if (event === "update") {
        this.eventEmitter.dispatchEvent(new CustomEvent(event, { detail: { keyPath, oldKeyPath } }));
      } else {
        this.eventEmitter.dispatchEvent(new CustomEvent(event, { detail: { keyPath } }));
      }
    }

    if (opts?.addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      await this.client.$outbox.create(
        {
          data: {
            entityType: this.modelName,
            operation: event,
            payload: record ?? keyPath,
          },
        },
        { tx: opts?.tx }
      );

      await this.client.$versionMeta.markLocalPending(this.modelName, keyPath, { tx: opts?.tx });
    }
  }
}
class BoardIDBClass extends BaseIDBModelClass<"Board"> {
  constructor(client: PrismaIDBClient, keyPath: string[]) {
    super(client, keyPath, "Board");
  }

  private async _applyWhereClause<
    W extends Prisma.Args<Prisma.BoardDelegate, "findFirstOrThrow">["where"],
    R extends Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">,
  >(records: R[], whereClause: W, tx: IDBUtils.TransactionType): Promise<R[]> {
    if (!whereClause) return records;
    records = await IDBUtils.applyLogicalFilters<Prisma.BoardDelegate, R, W>(
      records,
      whereClause,
      tx,
      this.keyPath,
      this._applyWhereClause.bind(this)
    );
    return (
      await Promise.all(
        records.map(async (record) => {
          const stringFields = ["id", "name", "userId"] as const;
          for (const field of stringFields) {
            if (!IDBUtils.whereStringFilter(record, field, whereClause[field])) return null;
          }
          const dateTimeFields = ["createdAt"] as const;
          for (const field of dateTimeFields) {
            if (!IDBUtils.whereDateTimeFilter(record, field, whereClause[field])) return null;
          }
          if (whereClause.todos) {
            if (whereClause.todos.every) {
              const violatingRecord = await this.client.todo.findFirst(
                {
                  where: { NOT: { ...whereClause.todos.every }, boardId: record.id },
                },
                { tx }
              );
              if (violatingRecord !== null) return null;
            }
            if (whereClause.todos.some) {
              const relatedRecords = await this.client.todo.findMany(
                {
                  where: { ...whereClause.todos.some, boardId: record.id },
                },
                { tx }
              );
              if (relatedRecords.length === 0) return null;
            }
            if (whereClause.todos.none) {
              const violatingRecord = await this.client.todo.findFirst(
                {
                  where: { ...whereClause.todos.none, boardId: record.id },
                },
                { tx }
              );
              if (violatingRecord !== null) return null;
            }
          }
          if (whereClause.user) {
            const { is, isNot, ...rest } = whereClause.user;
            if (is !== null && is !== undefined) {
              const relatedRecord = await this.client.user.findFirst({ where: { ...is, id: record.userId } }, { tx });
              if (!relatedRecord) return null;
            }
            if (isNot !== null && isNot !== undefined) {
              const relatedRecord = await this.client.user.findFirst(
                { where: { ...isNot, id: record.userId } },
                { tx }
              );
              if (relatedRecord) return null;
            }
            if (Object.keys(rest).length) {
              const relatedRecord = await this.client.user.findFirst(
                { where: { ...whereClause.user, id: record.userId } },
                { tx }
              );
              if (!relatedRecord) return null;
            }
          }
          return record;
        })
      )
    ).filter((result) => result !== null);
  }
  private _applySelectClause<S extends Prisma.Args<Prisma.BoardDelegate, "findMany">["select"]>(
    records: Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">[],
    selectClause: S
  ): Prisma.Result<Prisma.BoardDelegate, { select: S }, "findFirstOrThrow">[] {
    if (!selectClause) {
      return records as Prisma.Result<Prisma.BoardDelegate, { select: S }, "findFirstOrThrow">[];
    }
    return records.map((record) => {
      const partialRecord: Partial<typeof record> = { ...record };
      for (const untypedKey of ["id", "name", "createdAt", "todos", "user", "userId"]) {
        const key = untypedKey as keyof typeof record & keyof S;
        if (!selectClause[key]) delete partialRecord[key];
      }
      return partialRecord;
    }) as Prisma.Result<Prisma.BoardDelegate, { select: S }, "findFirstOrThrow">[];
  }
  private async _applyRelations<Q extends Prisma.Args<Prisma.BoardDelegate, "findMany">>(
    records: Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">[],
    tx: IDBUtils.TransactionType,
    query?: Q
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "findFirstOrThrow">[]> {
    if (!query) return records as Prisma.Result<Prisma.BoardDelegate, Q, "findFirstOrThrow">[];
    const attach_todos = query.select?.todos || query.include?.todos;
    const attach_user = query.select?.user || query.include?.user;
    if (!attach_todos && !attach_user) return records as Prisma.Result<Prisma.BoardDelegate, Q, "findFirstOrThrow">[];
    let todos_hashMap: Map<string, unknown[]> | undefined;
    if (attach_todos) {
      const todos_opts = (attach_todos === true ? {} : attach_todos) as Record<string, unknown>;
      const todos_sel = todos_opts.select as Record<string, boolean> | undefined;
      const todos_keysToInject = todos_sel ? (["boardId"] as string[]).filter((k) => !todos_sel![k]) : [];
      const todos_take = todos_opts.take as number | undefined;
      const todos_skip = todos_opts.skip as number | undefined;
      const todos_cursor = todos_opts.cursor;
      const todos_distinct = todos_opts.distinct;
      const todos_parentIds = [...new Set(records.map((r) => r.id))];
      todos_hashMap = new Map<string, unknown[]>();
      const todos_userWhere = todos_opts.where as Record<string, unknown> | undefined;
      if (todos_cursor !== undefined || todos_distinct !== undefined) {
        for (const parentId of todos_parentIds) {
          const todos_perParentFkWhere = { boardId: parentId };
          const todos_perParentWhere = todos_userWhere
            ? { AND: [todos_userWhere, todos_perParentFkWhere] }
            : todos_perParentFkWhere;
          const children = await this.client.todo.findMany(
            {
              ...todos_opts,
              ...(todos_keysToInject.length > 0
                ? { select: { ...todos_sel, ...Object.fromEntries(todos_keysToInject.map((k) => [k, true])) } }
                : {}),
              where: todos_perParentWhere,
            },
            { tx }
          );
          const stripped = children.map((c) => {
            const _r = c as Record<string, unknown>;
            return todos_keysToInject.length > 0
              ? Object.fromEntries(Object.entries(_r).filter(([k]) => !todos_keysToInject.includes(k)))
              : _r;
          });
          todos_hashMap!.set(JSON.stringify(parentId), stripped as unknown[]);
        }
      } else {
        const todos_fkWhere = { boardId: { in: todos_parentIds } };
        const todos_where = todos_userWhere ? { AND: [todos_userWhere, todos_fkWhere] } : todos_fkWhere;
        const todos_allRelated = await this.client.todo.findMany(
          {
            ...todos_opts,
            ...(todos_keysToInject.length > 0
              ? { select: { ...todos_sel, ...Object.fromEntries(todos_keysToInject.map((k) => [k, true])) } }
              : {}),
            take: undefined,
            skip: undefined,
            where: todos_where,
          },
          { tx }
        );
        for (const related of todos_allRelated) {
          const _r = related as Record<string, unknown>;
          const key = JSON.stringify(_r["boardId"]);
          if (!todos_hashMap!.has(key)) todos_hashMap!.set(key, []);
          const value =
            todos_keysToInject.length > 0
              ? Object.fromEntries(Object.entries(_r).filter(([k]) => !todos_keysToInject.includes(k)))
              : _r;
          todos_hashMap!.get(key)!.push(value as unknown);
        }
        if (todos_skip !== undefined || todos_take !== undefined) {
          if (todos_skip !== undefined && (!Number.isInteger(todos_skip) || todos_skip < 0))
            throw new Error("skip must be a non-negative integer");
          if (todos_take !== undefined && !Number.isInteger(todos_take)) throw new Error("take must be an integer");
          for (const [key, group] of todos_hashMap!) {
            let sliced = group;
            if (todos_skip !== undefined) sliced = sliced.slice(todos_skip);
            if (todos_take !== undefined)
              sliced = todos_take < 0 ? sliced.slice(todos_take) : sliced.slice(0, todos_take);
            todos_hashMap!.set(key, sliced);
          }
        }
      }
    }
    let user_hashMap: Map<string, unknown> | undefined;
    if (attach_user) {
      const user_opts = (attach_user === true ? {} : attach_user) as Record<string, unknown>;
      const user_sel = user_opts.select as Record<string, boolean> | undefined;
      const user_keysToInject = user_sel ? (["id"] as string[]).filter((k) => !user_sel![k]) : [];
      const user_fkValues = [...new Set(records.map((r) => r.userId).filter((v) => v !== null && v !== undefined))];
      const user_userWhere = user_opts.where as Record<string, unknown> | undefined;
      const user_fkWhere = { id: { in: user_fkValues } };
      const user_where = user_userWhere ? { AND: [user_userWhere, user_fkWhere] } : user_fkWhere;
      const user_related = await this.client.user.findMany(
        {
          ...user_opts,
          ...(user_keysToInject.length > 0
            ? { select: { ...user_sel, ...Object.fromEntries(user_keysToInject.map((k) => [k, true])) } }
            : {}),
          where: user_where,
        },
        { tx }
      );
      user_hashMap = new Map(
        user_related.map((r) => {
          const _r = r as Record<string, unknown>;
          const key = JSON.stringify(_r["id"]);
          const value =
            user_keysToInject.length > 0
              ? Object.fromEntries(Object.entries(_r).filter(([k]) => !user_keysToInject.includes(k)))
              : _r;
          return [key, value as unknown];
        })
      );
    }
    const recordsWithRelations = records.map((record) => {
      const unsafeRecord = record as Record<string, unknown>;
      if (attach_todos) {
        unsafeRecord["todos"] = (() => {
          const _v = todos_hashMap!.get(JSON.stringify(record.id));
          return _v == null ? [] : structuredClone(_v);
        })();
      }
      if (attach_user) {
        unsafeRecord["user"] = (() => {
          const _v = user_hashMap!.get(JSON.stringify(record.userId));
          return _v == null ? null : structuredClone(_v);
        })();
      }
      return unsafeRecord;
    });
    return recordsWithRelations as Prisma.Result<Prisma.BoardDelegate, Q, "findFirstOrThrow">[];
  }
  async _applyOrderByClause<
    O extends Prisma.Args<Prisma.BoardDelegate, "findMany">["orderBy"],
    R extends Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">,
  >(records: R[], orderByClause: O, tx: IDBUtils.TransactionType): Promise<void> {
    if (orderByClause === undefined) return;
    const orderByClauses = IDBUtils.convertToArray(orderByClause);
    const indexedKeys = await Promise.all(
      records.map(async (record) => {
        const keys = await Promise.all(
          orderByClauses.map(async (clause) => await this._resolveOrderByKey(record, clause, tx))
        );
        return { keys, record };
      })
    );
    indexedKeys.sort((a, b) => {
      for (let i = 0; i < orderByClauses.length; i++) {
        const clause = orderByClauses[i];
        const comparison = IDBUtils.genericComparator(a.keys[i], b.keys[i], this._resolveSortOrder(clause));
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
    for (let i = 0; i < records.length; i++) {
      records[i] = indexedKeys[i].record;
    }
  }
  async _resolveOrderByKey(
    record: Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">,
    orderByInput: Prisma.BoardOrderByWithRelationInput,
    tx: IDBUtils.TransactionType
  ): Promise<unknown> {
    const scalarFields = ["id", "name", "createdAt", "userId"] as const;
    for (const field of scalarFields) if (orderByInput[field]) return record[field];
    if (orderByInput.user) {
      return await this.client.user._resolveOrderByKey(
        await this.client.user.findFirstOrThrow({ where: { id: record.userId } }),
        orderByInput.user,
        tx
      );
    }
    if (orderByInput.todos) {
      return await this.client.todo.count({ where: { boardId: record.id } }, { tx });
    }
  }
  _resolveSortOrder(
    orderByInput: Prisma.BoardOrderByWithRelationInput
  ): Prisma.SortOrder | { sort: Prisma.SortOrder; nulls?: "first" | "last" } {
    const scalarFields = ["id", "name", "createdAt", "userId"] as const;
    for (const field of scalarFields) if (orderByInput[field]) return orderByInput[field];
    if (orderByInput.user) {
      return this.client.user._resolveSortOrder(orderByInput.user);
    }
    if (orderByInput.todos?._count) {
      return orderByInput.todos._count;
    }
    throw new Error("No field in orderBy clause");
  }
  private async _fillDefaults<D extends Prisma.Args<Prisma.BoardDelegate, "create">["data"]>(
    data: D,
    tx?: IDBUtils.ReadwriteTransactionType
  ): Promise<D> {
    if (data === undefined) data = {} as NonNullable<D>;
    if (data.id === undefined) {
      data.id = uuidv4();
    }
    if (data.createdAt === undefined) {
      data.createdAt = new Date();
    }
    if (typeof data.createdAt === "string") {
      data.createdAt = new Date(data.createdAt);
    }
    return data;
  }
  _getNeededStoresForWhere<W extends Prisma.Args<Prisma.BoardDelegate, "findMany">["where"]>(
    whereClause: W,
    neededStores: Set<StoreNames<PrismaIDBSchema>>
  ) {
    if (whereClause === undefined) return;
    for (const param of IDBUtils.LogicalParams) {
      if (whereClause[param]) {
        for (const clause of IDBUtils.convertToArray(whereClause[param])) {
          this._getNeededStoresForWhere(clause, neededStores);
        }
      }
    }
    if (whereClause.todos) {
      neededStores.add("Todo");
      this.client.todo._getNeededStoresForWhere(whereClause.todos.every, neededStores);
      this.client.todo._getNeededStoresForWhere(whereClause.todos.some, neededStores);
      this.client.todo._getNeededStoresForWhere(whereClause.todos.none, neededStores);
    }
    if (whereClause.user) {
      neededStores.add("User");
      this.client.user._getNeededStoresForWhere(whereClause.user, neededStores);
    }
  }
  _getNeededStoresForFind<Q extends Prisma.Args<Prisma.BoardDelegate, "findMany">>(
    query?: Q
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores: Set<StoreNames<PrismaIDBSchema>> = new Set();
    neededStores.add("Board");
    this._getNeededStoresForWhere(query?.where, neededStores);
    if (query?.orderBy) {
      const orderBy = IDBUtils.convertToArray(query.orderBy);
      const orderBy_todos = orderBy.find((clause) => clause.todos);
      if (orderBy_todos) {
        neededStores.add("Todo");
      }
      const orderBy_user = orderBy.find((clause) => clause.user);
      if (orderBy_user) {
        this.client.user
          ._getNeededStoresForFind({ orderBy: orderBy_user.user })
          .forEach((storeName) => neededStores.add(storeName));
      }
    }
    if (query?.select?.todos || query?.include?.todos) {
      neededStores.add("Todo");
      if (typeof query.select?.todos === "object") {
        this.client.todo
          ._getNeededStoresForFind(query.select.todos)
          .forEach((storeName) => neededStores.add(storeName));
      }
      if (typeof query.include?.todos === "object") {
        this.client.todo
          ._getNeededStoresForFind(query.include.todos)
          .forEach((storeName) => neededStores.add(storeName));
      }
    }
    if (query?.select?.user || query?.include?.user) {
      neededStores.add("User");
      if (typeof query.select?.user === "object") {
        this.client.user._getNeededStoresForFind(query.select.user).forEach((storeName) => neededStores.add(storeName));
      }
      if (typeof query.include?.user === "object") {
        this.client.user
          ._getNeededStoresForFind(query.include.user)
          .forEach((storeName) => neededStores.add(storeName));
      }
    }
    return neededStores;
  }
  _getNeededStoresForCreate<D extends Partial<Prisma.Args<Prisma.BoardDelegate, "create">["data"]>>(
    data: D
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores: Set<StoreNames<PrismaIDBSchema>> = new Set();
    neededStores.add("Board");
    if (data?.todos) {
      neededStores.add("Todo");
      if (data.todos.create) {
        const createData = Array.isArray(data.todos.create) ? data.todos.create : [data.todos.create];
        createData.forEach((record) =>
          this.client.todo._getNeededStoresForCreate(record).forEach((storeName) => neededStores.add(storeName))
        );
      }
      if (data.todos.connectOrCreate) {
        IDBUtils.convertToArray(data.todos.connectOrCreate).forEach((record) =>
          this.client.todo._getNeededStoresForCreate(record.create).forEach((storeName) => neededStores.add(storeName))
        );
      }
      if (data.todos.createMany) {
        IDBUtils.convertToArray(data.todos.createMany.data).forEach((record) =>
          this.client.todo._getNeededStoresForCreate(record).forEach((storeName) => neededStores.add(storeName))
        );
      }
    }
    if (data?.user) {
      neededStores.add("User");
      if (data.user.create) {
        const createData = Array.isArray(data.user.create) ? data.user.create : [data.user.create];
        createData.forEach((record) =>
          this.client.user._getNeededStoresForCreate(record).forEach((storeName) => neededStores.add(storeName))
        );
      }
      if (data.user.connectOrCreate) {
        IDBUtils.convertToArray(data.user.connectOrCreate).forEach((record) =>
          this.client.user._getNeededStoresForCreate(record.create).forEach((storeName) => neededStores.add(storeName))
        );
      }
    }
    if (data?.userId !== undefined) {
      neededStores.add("User");
    }
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
    return neededStores;
  }
  _getNeededStoresForUpdate<Q extends Prisma.Args<Prisma.BoardDelegate, "update">>(
    query: Partial<Q>
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores = this._getNeededStoresForFind(query).union(
      this._getNeededStoresForCreate(query.data as Prisma.Args<Prisma.BoardDelegate, "create">["data"])
    );
    if (query.data?.todos?.connect) {
      neededStores.add("Todo");
      IDBUtils.convertToArray(query.data.todos.connect).forEach((connect) => {
        this.client.todo._getNeededStoresForWhere(connect, neededStores);
      });
    }
    if (query.data?.todos?.set) {
      neededStores.add("Todo");
      IDBUtils.convertToArray(query.data.todos.set).forEach((setWhere) => {
        this.client.todo._getNeededStoresForWhere(setWhere, neededStores);
      });
    }
    if (query.data?.todos?.updateMany) {
      neededStores.add("Todo");
      IDBUtils.convertToArray(query.data.todos.updateMany).forEach((update) => {
        this.client.todo
          ._getNeededStoresForUpdate(update as Prisma.Args<Prisma.TodoDelegate, "update">)
          .forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.todos?.update) {
      neededStores.add("Todo");
      IDBUtils.convertToArray(query.data.todos.update).forEach((update) => {
        const normalizedUpdate = { ...update, data: update.data ?? update } as Prisma.Args<
          Prisma.TodoDelegate,
          "update"
        >;
        this.client.todo._getNeededStoresForUpdate(normalizedUpdate).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.todos?.upsert) {
      neededStores.add("Todo");
      IDBUtils.convertToArray(query.data.todos.upsert).forEach((upsert) => {
        const update = { where: upsert.where, data: { ...upsert.update, ...upsert.create } } as Prisma.Args<
          Prisma.TodoDelegate,
          "update"
        >;
        this.client.todo._getNeededStoresForUpdate(update).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.user?.connect) {
      neededStores.add("User");
      IDBUtils.convertToArray(query.data.user.connect).forEach((connect) => {
        this.client.user._getNeededStoresForWhere(connect, neededStores);
      });
    }
    if (query.data?.user?.update) {
      neededStores.add("User");
      IDBUtils.convertToArray(query.data.user.update).forEach((update) => {
        const normalizedUpdate = { ...update, data: update.data ?? update } as Prisma.Args<
          Prisma.UserDelegate,
          "update"
        >;
        this.client.user._getNeededStoresForUpdate(normalizedUpdate).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.user?.upsert) {
      neededStores.add("User");
      IDBUtils.convertToArray(query.data.user.upsert).forEach((upsert) => {
        const update = { where: upsert.where, data: { ...upsert.update, ...upsert.create } } as Prisma.Args<
          Prisma.UserDelegate,
          "update"
        >;
        this.client.user._getNeededStoresForUpdate(update).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.todos?.delete || query.data?.todos?.deleteMany) {
      this.client.todo._getNeededStoresForNestedDelete(neededStores);
    }
    if (query.data?.id !== undefined) {
      neededStores.add("Todo");
    }
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
    return neededStores;
  }
  _getNeededStoresForNestedDelete(neededStores: Set<StoreNames<PrismaIDBSchema>>): void {
    neededStores.add("Board");
    this.client.todo._getNeededStoresForNestedDelete(neededStores);
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
  }
  private _removeNestedCreateData<D extends Prisma.Args<Prisma.BoardDelegate, "create">["data"]>(
    data: D
  ): Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow"> {
    const recordWithoutNestedCreate = structuredClone(data);
    delete recordWithoutNestedCreate?.todos;
    delete recordWithoutNestedCreate?.user;
    return recordWithoutNestedCreate as Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">;
  }
  private _preprocessListFields(records: Prisma.Result<Prisma.BoardDelegate, object, "findMany">): void {}
  private async _getRecords(
    tx: IDBUtils.TransactionType,
    where?: Prisma.Args<Prisma.BoardDelegate, "findFirstOrThrow">["where"]
  ): Promise<Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">[]> {
    if (!where) return tx.objectStore("Board").getAll();
    const userIdEq = IDBUtils.extractEqualityValue(where.userId);

    if (userIdEq !== undefined) {
      return tx
        .objectStore("Board")
        .index("userIdIndex")
        .getAll(IDBUtils.IDBKeyRange.only([userIdEq]));
    }

    return tx.objectStore("Board").getAll();
  }
  private async _deleteRecord(
    record: Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">,
    tx: IDBUtils.ReadwriteTransactionType,
    options?: { silent?: boolean; addToOutbox?: boolean }
  ): Promise<void> {
    const { silent = false, addToOutbox = true } = options ?? {};
    await this.client.todo.deleteMany(
      {
        where: { boardId: record.id },
      },
      { tx, silent, addToOutbox }
    );
    await tx.objectStore("Board").delete([record.id]);
    await this.emit("delete", [record.id], undefined, record, { silent, addToOutbox, tx });
  }
  private async _updateRecord<Q extends Prisma.Args<Prisma.BoardDelegate, "update">>(
    record: Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">,
    query: Q,
    tx: IDBUtils.ReadwriteTransactionType,
    options?: { silent?: boolean; addToOutbox?: boolean }
  ): Promise<PrismaIDBSchema["Board"]["key"]> {
    const { silent = false, addToOutbox = true } = options ?? {};
    const startKeyPath: PrismaIDBSchema["Board"]["key"] = [record.id];
    if (query.data.todos) {
      if (query.data.todos.connect) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.connect).map(async (connectWhere) => {
            await this.client.todo.update(
              { where: connectWhere, data: { boardId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.todos.disconnect) {
        tx.abort();
        throw new Error("Cannot disconnect required relation");
      }
      if (query.data.todos.create) {
        const createData = Array.isArray(query.data.todos.create) ? query.data.todos.create : [query.data.todos.create];
        for (const elem of createData) {
          await this.client.todo.create(
            { data: { ...elem, boardId: record.id } as Prisma.Args<Prisma.TodoDelegate, "create">["data"] },
            { tx, silent, addToOutbox }
          );
        }
      }
      if (query.data.todos.createMany) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.createMany.data).map(async (createData) => {
            await this.client.todo.create({ data: { ...createData, boardId: record.id } }, { tx, silent, addToOutbox });
          })
        );
      }
      if (query.data.todos.update) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.update).map(async (updateData) => {
            await this.client.todo.update(
              { ...updateData, where: { ...updateData.where, boardId: record.id } as Prisma.TodoWhereUniqueInput },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.todos.updateMany) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.updateMany).map(async (updateData) => {
            await this.client.todo.updateMany(
              { ...updateData, where: { ...updateData.where, boardId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.todos.upsert) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.upsert).map(async (upsertData) => {
            await this.client.todo.upsert(
              {
                ...upsertData,
                where: { ...upsertData.where, boardId: record.id },
                create: { ...upsertData.create, boardId: record.id } as Prisma.Args<
                  Prisma.TodoDelegate,
                  "upsert"
                >["create"],
              },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.todos.delete) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.delete).map(async (deleteData) => {
            await this.client.todo.delete(
              { where: { ...deleteData, boardId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.todos.deleteMany) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.deleteMany).map(async (deleteData) => {
            await this.client.todo.deleteMany(
              { where: { ...deleteData, boardId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.todos.set) {
        const existing = await this.client.todo.findMany({ where: { boardId: record.id } }, { tx });
        if (existing.length > 0) {
          tx.abort();
          throw new Error("Cannot set required relation");
        }
        await Promise.all(
          IDBUtils.convertToArray(query.data.todos.set).map(async (setData) => {
            await this.client.todo.update(
              { where: setData, data: { boardId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
    }
    if (query.data.user) {
      if (query.data.user.connect) {
        const other = await this.client.user.findUniqueOrThrow({ where: query.data.user.connect }, { tx });
        record.userId = other.id;
      }
      if (query.data.user.create) {
        const other = await this.client.user.create({ data: query.data.user.create }, { tx, silent, addToOutbox });
        record.userId = other.id;
      }
      if (query.data.user.update) {
        const updateData = query.data.user.update.data ?? query.data.user.update;
        const other = await this.client.user.update(
          {
            where: { ...query.data.user.update.where, id: record.userId! } as Prisma.UserWhereUniqueInput,
            data: updateData,
          },
          { tx, silent, addToOutbox }
        );
        record.userId = other.id;
      }
      if (query.data.user.upsert) {
        const other = await this.client.user.upsert(
          {
            where: { ...query.data.user.upsert.where, id: record.userId! } as Prisma.UserWhereUniqueInput,
            create: { ...query.data.user.upsert.create, id: record.userId! } as Prisma.Args<
              Prisma.UserDelegate,
              "upsert"
            >["create"],
            update: query.data.user.upsert.update,
          },
          { tx, silent, addToOutbox }
        );
        record.userId = other.id;
      }
      if (query.data.user.connectOrCreate) {
        const other =
          (await this.client.user.findUnique({ where: query.data.user.connectOrCreate.where }, { tx })) ??
          (await this.client.user.create(
            { data: query.data.user.connectOrCreate.create as Prisma.Args<Prisma.UserDelegate, "create">["data"] },
            { tx, silent, addToOutbox }
          ));
        record.userId = other.id;
      }
    }
    const stringFields = ["id", "name", "userId"] as const;
    for (const field of stringFields) {
      IDBUtils.handleStringUpdateField(record, field, query.data[field]);
    }
    const dateTimeFields = ["createdAt"] as const;
    for (const field of dateTimeFields) {
      IDBUtils.handleDateTimeUpdateField(record, field, query.data[field]);
    }
    if (query.data.userId !== undefined) {
      const related = await this.client.user.findUnique({ where: { id: record.userId } }, { tx });
      if (!related) {
        tx.abort();
        throw new Error("Related record not found");
      }
    }
    const endKeyPath: PrismaIDBSchema["Board"]["key"] = [record.id];
    for (let i = 0; i < startKeyPath.length; i++) {
      if (startKeyPath[i] !== endKeyPath[i]) {
        if ((await tx.objectStore("Board").get(endKeyPath)) !== undefined) {
          tx.abort();
          throw new Error("Record with the same keyPath already exists");
        }
        await tx.objectStore("Board").delete(startKeyPath);
        break;
      }
    }
    const keyPath = await tx.objectStore("Board").put(record);
    await this.emit("update", keyPath, startKeyPath, record, { silent, addToOutbox, tx });
    for (let i = 0; i < startKeyPath.length; i++) {
      if (startKeyPath[i] !== endKeyPath[i]) {
        await this.client.todo.updateMany(
          {
            where: { boardId: startKeyPath[0] },
            data: { boardId: endKeyPath[0] },
          },
          { tx, silent, addToOutbox }
        );
        break;
      }
    }
    return keyPath;
  }
  async findMany<Q extends Prisma.Args<Prisma.BoardDelegate, "findMany">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "findMany">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    let records = await this._applyWhereClause(await this._getRecords(tx, query?.where), query?.where, tx);
    await this._applyOrderByClause(records, query?.orderBy, tx);
    if (query?.distinct) {
      const distinctFields = IDBUtils.convertToArray(query.distinct);
      const seen = new Set<string>();
      records = records.filter((record) => {
        const values = distinctFields.map((field) => record[field]);
        const key = JSON.stringify(values);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (query?.skip !== undefined) {
      if (!Number.isInteger(query.skip) || query.skip < 0) {
        throw new Error("skip must be a non-negative integer");
      }
    }
    if (query?.take !== undefined) {
      if (!Number.isInteger(query.take)) {
        throw new Error("take must be an integer");
      }
    }
    if (query?.cursor) {
      let cursorIndex = -1;
      if ((query.cursor as Record<string, unknown>)["id"] !== undefined) {
        const normalizedCursor = query.cursor as Record<string, unknown>;
        cursorIndex = records.findIndex((record) => record.id === normalizedCursor.id);
      }
      if (cursorIndex === -1) {
        records = [];
      } else if (query.take !== undefined && query.take < 0) {
        const skip = query.skip ?? 0;
        const end = cursorIndex + 1 - skip;
        const start = end + query.take;
        records = records.slice(Math.max(0, start), Math.max(0, end));
      } else {
        records = records.slice(cursorIndex);
      }
    }
    if (!(query?.cursor && query?.take !== undefined && query.take < 0)) {
      if (query?.skip !== undefined) {
        records = records.slice(query.skip);
      }
      if (query?.take !== undefined) {
        if (query.take < 0) {
          records = records.slice(query.take);
        } else {
          records = records.slice(0, query.take);
        }
      }
    }
    const relationAppliedRecords = (await this._applyRelations(records, tx, query)) as Prisma.Result<
      Prisma.BoardDelegate,
      object,
      "findFirstOrThrow"
    >[];
    const selectClause = query?.select;
    const selectAppliedRecords = this._applySelectClause(relationAppliedRecords, selectClause);
    this._preprocessListFields(selectAppliedRecords);
    return selectAppliedRecords as Prisma.Result<Prisma.BoardDelegate, Q, "findMany">;
  }
  async findFirst<Q extends Prisma.Args<Prisma.BoardDelegate, "findFirst">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "findFirst">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    return (await this.findMany(query, { tx }))[0] ?? null;
  }
  async findFirstOrThrow<Q extends Prisma.Args<Prisma.BoardDelegate, "findFirstOrThrow">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "findFirstOrThrow">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    const record = await this.findFirst(query, { tx });
    if (!record) {
      throw new Error("Record not found");
    }
    return record;
  }
  async findUnique<Q extends Prisma.Args<Prisma.BoardDelegate, "findUnique">>(
    query: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "findUnique">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    let record;
    if (query.where.id !== undefined) {
      record = await tx.objectStore("Board").get([query.where.id]);
    }
    if (!record) return null;

    const recordWithRelations = this._applySelectClause(
      await this._applyRelations(await this._applyWhereClause([record], query.where, tx), tx, query),
      query.select
    )[0];
    this._preprocessListFields([recordWithRelations]);
    return recordWithRelations as Prisma.Result<Prisma.BoardDelegate, Q, "findUnique">;
  }
  async findUniqueOrThrow<Q extends Prisma.Args<Prisma.BoardDelegate, "findUniqueOrThrow">>(
    query: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "findUniqueOrThrow">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    const record = await this.findUnique(query, { tx });
    if (!record) {
      throw new Error("Record not found");
    }
    return record;
  }
  async count<Q extends Prisma.Args<Prisma.BoardDelegate, "count">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "count">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(["Board"], "readonly");
    if (!query?.select || query.select === true) {
      const records = await this.findMany({ where: query?.where }, { tx });
      return records.length as Prisma.Result<Prisma.BoardDelegate, Q, "count">;
    }
    const result: Partial<Record<keyof Prisma.BoardCountAggregateInputType, number>> = {};
    for (const key of Object.keys(query.select)) {
      const typedKey = key as keyof typeof query.select;
      if (typedKey === "_all") {
        result[typedKey] = (await this.findMany({ where: query.where }, { tx })).length;
        continue;
      }
      result[typedKey] = (await this.findMany({ where: { [`${typedKey}`]: { not: null } } }, { tx })).length;
    }
    return result as Prisma.Result<Prisma.BoardDelegate, Q, "count">;
  }
  async create<Q extends Prisma.Args<Prisma.BoardDelegate, "create">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "create">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForCreate(query.data);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    if (query.data.user) {
      const fk: Partial<PrismaIDBSchema["User"]["key"]> = [];
      if (query.data.user?.create) {
        const record = await this.client.user.create({ data: query.data.user.create }, { tx, silent, addToOutbox });
        fk[0] = record.id;
      }
      if (query.data.user?.connect) {
        const record = await this.client.user.findUniqueOrThrow({ where: query.data.user.connect }, { tx });
        delete query.data.user.connect;
        fk[0] = record.id;
      }
      if (query.data.user?.connectOrCreate) {
        const record =
          (await this.client.user.findUnique({ where: query.data.user.connectOrCreate.where }, { tx })) ??
          (await this.client.user.create(
            { data: query.data.user.connectOrCreate.create },
            { tx, silent, addToOutbox }
          ));
        fk[0] = record.id;
      }
      const unsafeData = query.data as Record<string, unknown>;
      unsafeData.userId = fk[0];
      delete unsafeData.user;
    } else if (query.data?.userId !== undefined && query.data.userId !== null) {
      await this.client.user.findUniqueOrThrow(
        {
          where: { id: query.data.userId },
        },
        { tx }
      );
    }
    const record = this._removeNestedCreateData(await this._fillDefaults(query.data, tx));
    const keyPath = await tx.objectStore("Board").add(record);
    if (query.data?.todos?.create) {
      for (const elem of IDBUtils.convertToArray(query.data.todos.create)) {
        await this.client.todo.create(
          {
            data: { ...elem, board: { connect: { id: keyPath[0] } } } as Prisma.Args<
              Prisma.TodoDelegate,
              "create"
            >["data"],
          },
          { tx, silent, addToOutbox }
        );
      }
    }
    if (query.data?.todos?.connect) {
      await Promise.all(
        IDBUtils.convertToArray(query.data.todos.connect).map(async (connectWhere) => {
          await this.client.todo.update(
            { where: connectWhere, data: { boardId: keyPath[0] } },
            { tx, silent, addToOutbox }
          );
        })
      );
    }
    if (query.data?.todos?.connectOrCreate) {
      await Promise.all(
        IDBUtils.convertToArray(query.data.todos.connectOrCreate).map(async (connectOrCreate) => {
          await this.client.todo.upsert(
            {
              where: connectOrCreate.where,
              create: { ...connectOrCreate.create, boardId: keyPath[0] } as NonNullable<
                Prisma.Args<Prisma.TodoDelegate, "create">["data"]
              >,
              update: { boardId: keyPath[0] },
            },
            { tx, silent, addToOutbox }
          );
        })
      );
    }
    if (query.data?.todos?.createMany) {
      await this.client.todo.createMany(
        {
          data: IDBUtils.convertToArray(query.data.todos.createMany.data).map((createData) => ({
            ...createData,
            boardId: keyPath[0],
          })),
        },
        { tx, silent, addToOutbox }
      );
    }
    const data = (await tx.objectStore("Board").get(keyPath))!;
    const recordsWithRelations = this._applySelectClause(
      await this._applyRelations<object>([data], tx, query),
      query.select
    )[0];
    this._preprocessListFields([recordsWithRelations]);
    await this.emit("create", keyPath, undefined, data, { silent, addToOutbox, tx });
    return recordsWithRelations as Prisma.Result<Prisma.BoardDelegate, Q, "create">;
  }
  async createMany<Q extends Prisma.Args<Prisma.BoardDelegate, "createMany">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "createMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const createManyData = IDBUtils.convertToArray(query.data);
    const storesNeeded: Set<StoreNames<PrismaIDBSchema>> = new Set(["Board"]);
    if (addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      storesNeeded.add("OutboxEvent");
      storesNeeded.add("VersionMeta");
    }
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    for (const createData of createManyData) {
      const record = this._removeNestedCreateData(await this._fillDefaults(createData, tx));
      const keyPath = await tx.objectStore("Board").add(record);
      await this.emit("create", keyPath, undefined, record, { silent, addToOutbox, tx });
    }
    return { count: createManyData.length };
  }
  async createManyAndReturn<Q extends Prisma.Args<Prisma.BoardDelegate, "createManyAndReturn">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "createManyAndReturn">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const createManyData = IDBUtils.convertToArray(query.data);
    const records: Prisma.Result<Prisma.BoardDelegate, object, "findMany"> = [];
    const storesNeeded: Set<StoreNames<PrismaIDBSchema>> = new Set(["Board"]);
    if (addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      storesNeeded.add("OutboxEvent");
      storesNeeded.add("VersionMeta");
    }
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    for (const createData of createManyData) {
      const record = this._removeNestedCreateData(await this._fillDefaults(createData, tx));
      const keyPath = await tx.objectStore("Board").add(record);
      await this.emit("create", keyPath, undefined, record, { silent, addToOutbox, tx });
      records.push(this._applySelectClause([record], query.select)[0]);
    }
    this._preprocessListFields(records);
    return records as Prisma.Result<Prisma.BoardDelegate, Q, "createManyAndReturn">;
  }
  async delete<Q extends Prisma.Args<Prisma.BoardDelegate, "delete">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "delete">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForFind(query);
    this._getNeededStoresForNestedDelete(storesNeeded);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    let recordForDelete: Prisma.Result<Prisma.BoardDelegate, object, "findFirstOrThrow">;
    try {
      recordForDelete = (await this.findUniqueOrThrow({ where: query.where }, { tx })) as Prisma.Result<
        Prisma.BoardDelegate,
        object,
        "findFirstOrThrow"
      >;
    } catch (e) {
      tx.abort();
      throw e;
    }
    const projectionRecord = structuredClone(recordForDelete);
    const recordsWithRelations = await this._applyRelations([projectionRecord], tx, query);
    const record = this._applySelectClause(recordsWithRelations, query.select)[0];
    this._preprocessListFields([record]);
    await this._deleteRecord(recordForDelete, tx, { silent, addToOutbox });
    return record as Prisma.Result<Prisma.BoardDelegate, Q, "delete">;
  }
  async deleteMany<Q extends Prisma.Args<Prisma.BoardDelegate, "deleteMany">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "deleteMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForFind(query);
    this._getNeededStoresForNestedDelete(storesNeeded);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    const records = await this.findMany(query, { tx });
    await Promise.all(records.map((record) => this._deleteRecord(record, tx, { silent, addToOutbox })));
    return { count: records.length };
  }
  async update<Q extends Prisma.Args<Prisma.BoardDelegate, "update">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "update">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForUpdate(query)), "readwrite");
    const record = await this.findUnique({ where: query.where }, { tx });
    if (record === null) {
      tx.abort();
      throw new Error("Record not found");
    }
    const keyPath = await this._updateRecord(record, query, tx, { silent, addToOutbox });
    const recordWithRelations = (await this.findUnique(
      {
        where: { id: keyPath[0] },
        select: query.select,
        ...("include" in query ? { include: query.include } : {}),
      },
      { tx }
    ))!;
    return recordWithRelations as Prisma.Result<Prisma.BoardDelegate, Q, "update">;
  }
  async updateMany<Q extends Prisma.Args<Prisma.BoardDelegate, "updateMany">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "updateMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    tx =
      tx ??
      this.client._db.transaction(
        Array.from(this._getNeededStoresForUpdate(query as unknown as Prisma.Args<Prisma.BoardDelegate, "update">)),
        "readwrite"
      );
    const records = await this.findMany({ where: query.where }, { tx });
    for (const record of records) {
      const updateQuery = {
        where: { id: record.id },
        data: query.data,
      } as Prisma.Args<Prisma.BoardDelegate, "update">;
      await this._updateRecord(record, updateQuery, tx, { silent, addToOutbox });
    }
    return { count: records.length };
  }
  async upsert<Q extends Prisma.Args<Prisma.BoardDelegate, "upsert">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "upsert">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const neededStores = this._getNeededStoresForUpdate({
      ...query,
      data: { ...query.update, ...query.create } as Prisma.Args<Prisma.BoardDelegate, "update">["data"],
    });
    tx = tx ?? this.client._db.transaction(Array.from(neededStores), "readwrite");
    let record = await this.findUnique({ where: query.where }, { tx });
    if (!record) record = await this.create({ data: query.create }, { tx, silent, addToOutbox });
    else record = await this.update({ where: query.where, data: query.update }, { tx, silent, addToOutbox });
    record = await this.findUniqueOrThrow(
      { where: { id: record.id }, select: query.select, include: query.include },
      { tx }
    );
    return record as Prisma.Result<Prisma.BoardDelegate, Q, "upsert">;
  }
  async aggregate<Q extends Prisma.Args<Prisma.BoardDelegate, "aggregate">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.BoardDelegate, Q, "aggregate">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(["Board"], "readonly");
    const records = await this.findMany({ where: query?.where }, { tx });
    const result: Partial<Prisma.Result<Prisma.BoardDelegate, Q, "aggregate">> = {};
    if (query?._count) {
      if (query._count === true) {
        (result._count as number) = records.length;
      } else {
        for (const key of Object.keys(query._count)) {
          const typedKey = key as keyof typeof query._count;
          if (typedKey === "_all") {
            (result._count as Record<string, number>)[typedKey] = records.length;
            continue;
          }
          (result._count as Record<string, number>)[typedKey] = (
            await this.findMany({ where: { [`${typedKey}`]: { not: null } } }, { tx })
          ).length;
        }
      }
    }
    if (query?._min) {
      const minResult = {} as Prisma.Result<Prisma.BoardDelegate, Q, "aggregate">["_min"];
      const dateTimeFields = ["createdAt"] as const;
      for (const field of dateTimeFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field]?.getTime()).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as Date) = new Date(Math.min(...values));
      }
      const stringFields = ["id", "name", "userId"] as const;
      for (const field of stringFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field] as string).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as string) = values.sort()[0];
      }
      result._min = minResult;
    }
    if (query?._max) {
      const maxResult = {} as Prisma.Result<Prisma.BoardDelegate, Q, "aggregate">["_max"];
      const dateTimeFields = ["createdAt"] as const;
      for (const field of dateTimeFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field]?.getTime()).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as Date) = new Date(Math.max(...values));
      }
      const stringFields = ["id", "name", "userId"] as const;
      for (const field of stringFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field] as string).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as string) = values.sort().reverse()[0];
      }
      result._max = maxResult;
    }
    return result as unknown as Prisma.Result<Prisma.BoardDelegate, Q, "aggregate">;
  }
}
class TodoIDBClass extends BaseIDBModelClass<"Todo"> {
  constructor(client: PrismaIDBClient, keyPath: string[]) {
    super(client, keyPath, "Todo");
  }

  private async _applyWhereClause<
    W extends Prisma.Args<Prisma.TodoDelegate, "findFirstOrThrow">["where"],
    R extends Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">,
  >(records: R[], whereClause: W, tx: IDBUtils.TransactionType): Promise<R[]> {
    if (!whereClause) return records;
    records = await IDBUtils.applyLogicalFilters<Prisma.TodoDelegate, R, W>(
      records,
      whereClause,
      tx,
      this.keyPath,
      this._applyWhereClause.bind(this)
    );
    return (
      await Promise.all(
        records.map(async (record) => {
          const stringFields = ["id", "title", "description", "boardId"] as const;
          for (const field of stringFields) {
            if (!IDBUtils.whereStringFilter(record, field, whereClause[field])) return null;
          }
          const booleanFields = ["isCompleted"] as const;
          for (const field of booleanFields) {
            if (!IDBUtils.whereBoolFilter(record, field, whereClause[field])) return null;
          }
          const dateTimeFields = ["createdAt"] as const;
          for (const field of dateTimeFields) {
            if (!IDBUtils.whereDateTimeFilter(record, field, whereClause[field])) return null;
          }
          if (whereClause.board) {
            const { is, isNot, ...rest } = whereClause.board;
            if (is !== null && is !== undefined) {
              const relatedRecord = await this.client.board.findFirst({ where: { ...is, id: record.boardId } }, { tx });
              if (!relatedRecord) return null;
            }
            if (isNot !== null && isNot !== undefined) {
              const relatedRecord = await this.client.board.findFirst(
                { where: { ...isNot, id: record.boardId } },
                { tx }
              );
              if (relatedRecord) return null;
            }
            if (Object.keys(rest).length) {
              const relatedRecord = await this.client.board.findFirst(
                { where: { ...whereClause.board, id: record.boardId } },
                { tx }
              );
              if (!relatedRecord) return null;
            }
          }
          return record;
        })
      )
    ).filter((result) => result !== null);
  }
  private _applySelectClause<S extends Prisma.Args<Prisma.TodoDelegate, "findMany">["select"]>(
    records: Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">[],
    selectClause: S
  ): Prisma.Result<Prisma.TodoDelegate, { select: S }, "findFirstOrThrow">[] {
    if (!selectClause) {
      return records as Prisma.Result<Prisma.TodoDelegate, { select: S }, "findFirstOrThrow">[];
    }
    return records.map((record) => {
      const partialRecord: Partial<typeof record> = { ...record };
      for (const untypedKey of ["id", "title", "description", "isCompleted", "createdAt", "board", "boardId"]) {
        const key = untypedKey as keyof typeof record & keyof S;
        if (!selectClause[key]) delete partialRecord[key];
      }
      return partialRecord;
    }) as Prisma.Result<Prisma.TodoDelegate, { select: S }, "findFirstOrThrow">[];
  }
  private async _applyRelations<Q extends Prisma.Args<Prisma.TodoDelegate, "findMany">>(
    records: Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">[],
    tx: IDBUtils.TransactionType,
    query?: Q
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "findFirstOrThrow">[]> {
    if (!query) return records as Prisma.Result<Prisma.TodoDelegate, Q, "findFirstOrThrow">[];
    const attach_board = query.select?.board || query.include?.board;
    if (!attach_board) return records as Prisma.Result<Prisma.TodoDelegate, Q, "findFirstOrThrow">[];
    let board_hashMap: Map<string, unknown> | undefined;
    if (attach_board) {
      const board_opts = (attach_board === true ? {} : attach_board) as Record<string, unknown>;
      const board_sel = board_opts.select as Record<string, boolean> | undefined;
      const board_keysToInject = board_sel ? (["id"] as string[]).filter((k) => !board_sel![k]) : [];
      const board_fkValues = [...new Set(records.map((r) => r.boardId).filter((v) => v !== null && v !== undefined))];
      const board_userWhere = board_opts.where as Record<string, unknown> | undefined;
      const board_fkWhere = { id: { in: board_fkValues } };
      const board_where = board_userWhere ? { AND: [board_userWhere, board_fkWhere] } : board_fkWhere;
      const board_related = await this.client.board.findMany(
        {
          ...board_opts,
          ...(board_keysToInject.length > 0
            ? { select: { ...board_sel, ...Object.fromEntries(board_keysToInject.map((k) => [k, true])) } }
            : {}),
          where: board_where,
        },
        { tx }
      );
      board_hashMap = new Map(
        board_related.map((r) => {
          const _r = r as Record<string, unknown>;
          const key = JSON.stringify(_r["id"]);
          const value =
            board_keysToInject.length > 0
              ? Object.fromEntries(Object.entries(_r).filter(([k]) => !board_keysToInject.includes(k)))
              : _r;
          return [key, value as unknown];
        })
      );
    }
    const recordsWithRelations = records.map((record) => {
      const unsafeRecord = record as Record<string, unknown>;
      if (attach_board) {
        unsafeRecord["board"] = (() => {
          const _v = board_hashMap!.get(JSON.stringify(record.boardId));
          return _v == null ? null : structuredClone(_v);
        })();
      }
      return unsafeRecord;
    });
    return recordsWithRelations as Prisma.Result<Prisma.TodoDelegate, Q, "findFirstOrThrow">[];
  }
  async _applyOrderByClause<
    O extends Prisma.Args<Prisma.TodoDelegate, "findMany">["orderBy"],
    R extends Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">,
  >(records: R[], orderByClause: O, tx: IDBUtils.TransactionType): Promise<void> {
    if (orderByClause === undefined) return;
    const orderByClauses = IDBUtils.convertToArray(orderByClause);
    const indexedKeys = await Promise.all(
      records.map(async (record) => {
        const keys = await Promise.all(
          orderByClauses.map(async (clause) => await this._resolveOrderByKey(record, clause, tx))
        );
        return { keys, record };
      })
    );
    indexedKeys.sort((a, b) => {
      for (let i = 0; i < orderByClauses.length; i++) {
        const clause = orderByClauses[i];
        const comparison = IDBUtils.genericComparator(a.keys[i], b.keys[i], this._resolveSortOrder(clause));
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
    for (let i = 0; i < records.length; i++) {
      records[i] = indexedKeys[i].record;
    }
  }
  async _resolveOrderByKey(
    record: Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">,
    orderByInput: Prisma.TodoOrderByWithRelationInput,
    tx: IDBUtils.TransactionType
  ): Promise<unknown> {
    const scalarFields = ["id", "title", "description", "isCompleted", "createdAt", "boardId"] as const;
    for (const field of scalarFields) if (orderByInput[field]) return record[field];
    if (orderByInput.board) {
      return await this.client.board._resolveOrderByKey(
        await this.client.board.findFirstOrThrow({ where: { id: record.boardId } }),
        orderByInput.board,
        tx
      );
    }
  }
  _resolveSortOrder(
    orderByInput: Prisma.TodoOrderByWithRelationInput
  ): Prisma.SortOrder | { sort: Prisma.SortOrder; nulls?: "first" | "last" } {
    const scalarFields = ["id", "title", "description", "isCompleted", "createdAt", "boardId"] as const;
    for (const field of scalarFields) if (orderByInput[field]) return orderByInput[field];
    if (orderByInput.board) {
      return this.client.board._resolveSortOrder(orderByInput.board);
    }
    throw new Error("No field in orderBy clause");
  }
  private async _fillDefaults<D extends Prisma.Args<Prisma.TodoDelegate, "create">["data"]>(
    data: D,
    tx?: IDBUtils.ReadwriteTransactionType
  ): Promise<D> {
    if (data === undefined) data = {} as NonNullable<D>;
    if (data.id === undefined) {
      data.id = uuidv4();
    }
    if (data.description === undefined) {
      data.description = null;
    }
    if (data.isCompleted === undefined) {
      data.isCompleted = false;
    }
    if (data.createdAt === undefined) {
      data.createdAt = new Date();
    }
    if (typeof data.createdAt === "string") {
      data.createdAt = new Date(data.createdAt);
    }
    return data;
  }
  _getNeededStoresForWhere<W extends Prisma.Args<Prisma.TodoDelegate, "findMany">["where"]>(
    whereClause: W,
    neededStores: Set<StoreNames<PrismaIDBSchema>>
  ) {
    if (whereClause === undefined) return;
    for (const param of IDBUtils.LogicalParams) {
      if (whereClause[param]) {
        for (const clause of IDBUtils.convertToArray(whereClause[param])) {
          this._getNeededStoresForWhere(clause, neededStores);
        }
      }
    }
    if (whereClause.board) {
      neededStores.add("Board");
      this.client.board._getNeededStoresForWhere(whereClause.board, neededStores);
    }
  }
  _getNeededStoresForFind<Q extends Prisma.Args<Prisma.TodoDelegate, "findMany">>(
    query?: Q
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores: Set<StoreNames<PrismaIDBSchema>> = new Set();
    neededStores.add("Todo");
    this._getNeededStoresForWhere(query?.where, neededStores);
    if (query?.orderBy) {
      const orderBy = IDBUtils.convertToArray(query.orderBy);
      const orderBy_board = orderBy.find((clause) => clause.board);
      if (orderBy_board) {
        this.client.board
          ._getNeededStoresForFind({ orderBy: orderBy_board.board })
          .forEach((storeName) => neededStores.add(storeName));
      }
    }
    if (query?.select?.board || query?.include?.board) {
      neededStores.add("Board");
      if (typeof query.select?.board === "object") {
        this.client.board
          ._getNeededStoresForFind(query.select.board)
          .forEach((storeName) => neededStores.add(storeName));
      }
      if (typeof query.include?.board === "object") {
        this.client.board
          ._getNeededStoresForFind(query.include.board)
          .forEach((storeName) => neededStores.add(storeName));
      }
    }
    return neededStores;
  }
  _getNeededStoresForCreate<D extends Partial<Prisma.Args<Prisma.TodoDelegate, "create">["data"]>>(
    data: D
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores: Set<StoreNames<PrismaIDBSchema>> = new Set();
    neededStores.add("Todo");
    if (data?.board) {
      neededStores.add("Board");
      if (data.board.create) {
        const createData = Array.isArray(data.board.create) ? data.board.create : [data.board.create];
        createData.forEach((record) =>
          this.client.board._getNeededStoresForCreate(record).forEach((storeName) => neededStores.add(storeName))
        );
      }
      if (data.board.connectOrCreate) {
        IDBUtils.convertToArray(data.board.connectOrCreate).forEach((record) =>
          this.client.board._getNeededStoresForCreate(record.create).forEach((storeName) => neededStores.add(storeName))
        );
      }
    }
    if (data?.boardId !== undefined) {
      neededStores.add("Board");
    }
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
    return neededStores;
  }
  _getNeededStoresForUpdate<Q extends Prisma.Args<Prisma.TodoDelegate, "update">>(
    query: Partial<Q>
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores = this._getNeededStoresForFind(query).union(
      this._getNeededStoresForCreate(query.data as Prisma.Args<Prisma.TodoDelegate, "create">["data"])
    );
    if (query.data?.board?.connect) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.board.connect).forEach((connect) => {
        this.client.board._getNeededStoresForWhere(connect, neededStores);
      });
    }
    if (query.data?.board?.update) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.board.update).forEach((update) => {
        const normalizedUpdate = { ...update, data: update.data ?? update } as Prisma.Args<
          Prisma.BoardDelegate,
          "update"
        >;
        this.client.board._getNeededStoresForUpdate(normalizedUpdate).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.board?.upsert) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.board.upsert).forEach((upsert) => {
        const update = { where: upsert.where, data: { ...upsert.update, ...upsert.create } } as Prisma.Args<
          Prisma.BoardDelegate,
          "update"
        >;
        this.client.board._getNeededStoresForUpdate(update).forEach((store) => neededStores.add(store));
      });
    }
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
    return neededStores;
  }
  _getNeededStoresForNestedDelete(neededStores: Set<StoreNames<PrismaIDBSchema>>): void {
    neededStores.add("Todo");
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
  }
  private _removeNestedCreateData<D extends Prisma.Args<Prisma.TodoDelegate, "create">["data"]>(
    data: D
  ): Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow"> {
    const recordWithoutNestedCreate = structuredClone(data);
    delete recordWithoutNestedCreate?.board;
    return recordWithoutNestedCreate as Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">;
  }
  private _preprocessListFields(records: Prisma.Result<Prisma.TodoDelegate, object, "findMany">): void {}
  private async _getRecords(
    tx: IDBUtils.TransactionType,
    where?: Prisma.Args<Prisma.TodoDelegate, "findFirstOrThrow">["where"]
  ): Promise<Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">[]> {
    if (!where) return tx.objectStore("Todo").getAll();
    const boardIdEq = IDBUtils.extractEqualityValue(where.boardId);

    if (boardIdEq !== undefined) {
      return tx
        .objectStore("Todo")
        .index("boardIdIndex")
        .getAll(IDBUtils.IDBKeyRange.only([boardIdEq]));
    }

    return tx.objectStore("Todo").getAll();
  }
  private async _deleteRecord(
    record: Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">,
    tx: IDBUtils.ReadwriteTransactionType,
    options?: { silent?: boolean; addToOutbox?: boolean }
  ): Promise<void> {
    const { silent = false, addToOutbox = true } = options ?? {};
    await tx.objectStore("Todo").delete([record.id]);
    await this.emit("delete", [record.id], undefined, record, { silent, addToOutbox, tx });
  }
  private async _updateRecord<Q extends Prisma.Args<Prisma.TodoDelegate, "update">>(
    record: Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">,
    query: Q,
    tx: IDBUtils.ReadwriteTransactionType,
    options?: { silent?: boolean; addToOutbox?: boolean }
  ): Promise<PrismaIDBSchema["Todo"]["key"]> {
    const { silent = false, addToOutbox = true } = options ?? {};
    const startKeyPath: PrismaIDBSchema["Todo"]["key"] = [record.id];
    if (query.data.board) {
      if (query.data.board.connect) {
        const other = await this.client.board.findUniqueOrThrow({ where: query.data.board.connect }, { tx });
        record.boardId = other.id;
      }
      if (query.data.board.create) {
        const other = await this.client.board.create({ data: query.data.board.create }, { tx, silent, addToOutbox });
        record.boardId = other.id;
      }
      if (query.data.board.update) {
        const updateData = query.data.board.update.data ?? query.data.board.update;
        const other = await this.client.board.update(
          {
            where: { ...query.data.board.update.where, id: record.boardId! } as Prisma.BoardWhereUniqueInput,
            data: updateData,
          },
          { tx, silent, addToOutbox }
        );
        record.boardId = other.id;
      }
      if (query.data.board.upsert) {
        const other = await this.client.board.upsert(
          {
            where: { ...query.data.board.upsert.where, id: record.boardId! } as Prisma.BoardWhereUniqueInput,
            create: { ...query.data.board.upsert.create, id: record.boardId! } as Prisma.Args<
              Prisma.BoardDelegate,
              "upsert"
            >["create"],
            update: query.data.board.upsert.update,
          },
          { tx, silent, addToOutbox }
        );
        record.boardId = other.id;
      }
      if (query.data.board.connectOrCreate) {
        const other =
          (await this.client.board.findUnique({ where: query.data.board.connectOrCreate.where }, { tx })) ??
          (await this.client.board.create(
            { data: query.data.board.connectOrCreate.create as Prisma.Args<Prisma.BoardDelegate, "create">["data"] },
            { tx, silent, addToOutbox }
          ));
        record.boardId = other.id;
      }
    }
    const stringFields = ["id", "title", "description", "boardId"] as const;
    for (const field of stringFields) {
      IDBUtils.handleStringUpdateField(record, field, query.data[field]);
    }
    const dateTimeFields = ["createdAt"] as const;
    for (const field of dateTimeFields) {
      IDBUtils.handleDateTimeUpdateField(record, field, query.data[field]);
    }
    const booleanFields = ["isCompleted"] as const;
    for (const field of booleanFields) {
      IDBUtils.handleBooleanUpdateField(record, field, query.data[field]);
    }
    if (query.data.boardId !== undefined) {
      const related = await this.client.board.findUnique({ where: { id: record.boardId } }, { tx });
      if (!related) {
        tx.abort();
        throw new Error("Related record not found");
      }
    }
    const endKeyPath: PrismaIDBSchema["Todo"]["key"] = [record.id];
    for (let i = 0; i < startKeyPath.length; i++) {
      if (startKeyPath[i] !== endKeyPath[i]) {
        if ((await tx.objectStore("Todo").get(endKeyPath)) !== undefined) {
          tx.abort();
          throw new Error("Record with the same keyPath already exists");
        }
        await tx.objectStore("Todo").delete(startKeyPath);
        break;
      }
    }
    const keyPath = await tx.objectStore("Todo").put(record);
    await this.emit("update", keyPath, startKeyPath, record, { silent, addToOutbox, tx });
    return keyPath;
  }
  async findMany<Q extends Prisma.Args<Prisma.TodoDelegate, "findMany">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "findMany">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    let records = await this._applyWhereClause(await this._getRecords(tx, query?.where), query?.where, tx);
    await this._applyOrderByClause(records, query?.orderBy, tx);
    if (query?.distinct) {
      const distinctFields = IDBUtils.convertToArray(query.distinct);
      const seen = new Set<string>();
      records = records.filter((record) => {
        const values = distinctFields.map((field) => record[field]);
        const key = JSON.stringify(values);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (query?.skip !== undefined) {
      if (!Number.isInteger(query.skip) || query.skip < 0) {
        throw new Error("skip must be a non-negative integer");
      }
    }
    if (query?.take !== undefined) {
      if (!Number.isInteger(query.take)) {
        throw new Error("take must be an integer");
      }
    }
    if (query?.cursor) {
      let cursorIndex = -1;
      if ((query.cursor as Record<string, unknown>)["id"] !== undefined) {
        const normalizedCursor = query.cursor as Record<string, unknown>;
        cursorIndex = records.findIndex((record) => record.id === normalizedCursor.id);
      }
      if (cursorIndex === -1) {
        records = [];
      } else if (query.take !== undefined && query.take < 0) {
        const skip = query.skip ?? 0;
        const end = cursorIndex + 1 - skip;
        const start = end + query.take;
        records = records.slice(Math.max(0, start), Math.max(0, end));
      } else {
        records = records.slice(cursorIndex);
      }
    }
    if (!(query?.cursor && query?.take !== undefined && query.take < 0)) {
      if (query?.skip !== undefined) {
        records = records.slice(query.skip);
      }
      if (query?.take !== undefined) {
        if (query.take < 0) {
          records = records.slice(query.take);
        } else {
          records = records.slice(0, query.take);
        }
      }
    }
    const relationAppliedRecords = (await this._applyRelations(records, tx, query)) as Prisma.Result<
      Prisma.TodoDelegate,
      object,
      "findFirstOrThrow"
    >[];
    const selectClause = query?.select;
    const selectAppliedRecords = this._applySelectClause(relationAppliedRecords, selectClause);
    this._preprocessListFields(selectAppliedRecords);
    return selectAppliedRecords as Prisma.Result<Prisma.TodoDelegate, Q, "findMany">;
  }
  async findFirst<Q extends Prisma.Args<Prisma.TodoDelegate, "findFirst">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "findFirst">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    return (await this.findMany(query, { tx }))[0] ?? null;
  }
  async findFirstOrThrow<Q extends Prisma.Args<Prisma.TodoDelegate, "findFirstOrThrow">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "findFirstOrThrow">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    const record = await this.findFirst(query, { tx });
    if (!record) {
      throw new Error("Record not found");
    }
    return record;
  }
  async findUnique<Q extends Prisma.Args<Prisma.TodoDelegate, "findUnique">>(
    query: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "findUnique">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    let record;
    if (query.where.id !== undefined) {
      record = await tx.objectStore("Todo").get([query.where.id]);
    }
    if (!record) return null;

    const recordWithRelations = this._applySelectClause(
      await this._applyRelations(await this._applyWhereClause([record], query.where, tx), tx, query),
      query.select
    )[0];
    this._preprocessListFields([recordWithRelations]);
    return recordWithRelations as Prisma.Result<Prisma.TodoDelegate, Q, "findUnique">;
  }
  async findUniqueOrThrow<Q extends Prisma.Args<Prisma.TodoDelegate, "findUniqueOrThrow">>(
    query: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "findUniqueOrThrow">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    const record = await this.findUnique(query, { tx });
    if (!record) {
      throw new Error("Record not found");
    }
    return record;
  }
  async count<Q extends Prisma.Args<Prisma.TodoDelegate, "count">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "count">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(["Todo"], "readonly");
    if (!query?.select || query.select === true) {
      const records = await this.findMany({ where: query?.where }, { tx });
      return records.length as Prisma.Result<Prisma.TodoDelegate, Q, "count">;
    }
    const result: Partial<Record<keyof Prisma.TodoCountAggregateInputType, number>> = {};
    for (const key of Object.keys(query.select)) {
      const typedKey = key as keyof typeof query.select;
      if (typedKey === "_all") {
        result[typedKey] = (await this.findMany({ where: query.where }, { tx })).length;
        continue;
      }
      result[typedKey] = (await this.findMany({ where: { [`${typedKey}`]: { not: null } } }, { tx })).length;
    }
    return result as Prisma.Result<Prisma.TodoDelegate, Q, "count">;
  }
  async create<Q extends Prisma.Args<Prisma.TodoDelegate, "create">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "create">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForCreate(query.data);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    if (query.data.board) {
      const fk: Partial<PrismaIDBSchema["Board"]["key"]> = [];
      if (query.data.board?.create) {
        const record = await this.client.board.create({ data: query.data.board.create }, { tx, silent, addToOutbox });
        fk[0] = record.id;
      }
      if (query.data.board?.connect) {
        const record = await this.client.board.findUniqueOrThrow({ where: query.data.board.connect }, { tx });
        delete query.data.board.connect;
        fk[0] = record.id;
      }
      if (query.data.board?.connectOrCreate) {
        const record =
          (await this.client.board.findUnique({ where: query.data.board.connectOrCreate.where }, { tx })) ??
          (await this.client.board.create(
            { data: query.data.board.connectOrCreate.create },
            { tx, silent, addToOutbox }
          ));
        fk[0] = record.id;
      }
      const unsafeData = query.data as Record<string, unknown>;
      unsafeData.boardId = fk[0];
      delete unsafeData.board;
    } else if (query.data?.boardId !== undefined && query.data.boardId !== null) {
      await this.client.board.findUniqueOrThrow(
        {
          where: { id: query.data.boardId },
        },
        { tx }
      );
    }
    const record = this._removeNestedCreateData(await this._fillDefaults(query.data, tx));
    const keyPath = await tx.objectStore("Todo").add(record);
    const data = (await tx.objectStore("Todo").get(keyPath))!;
    const recordsWithRelations = this._applySelectClause(
      await this._applyRelations<object>([data], tx, query),
      query.select
    )[0];
    this._preprocessListFields([recordsWithRelations]);
    await this.emit("create", keyPath, undefined, data, { silent, addToOutbox, tx });
    return recordsWithRelations as Prisma.Result<Prisma.TodoDelegate, Q, "create">;
  }
  async createMany<Q extends Prisma.Args<Prisma.TodoDelegate, "createMany">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "createMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const createManyData = IDBUtils.convertToArray(query.data);
    const storesNeeded: Set<StoreNames<PrismaIDBSchema>> = new Set(["Todo"]);
    if (addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      storesNeeded.add("OutboxEvent");
      storesNeeded.add("VersionMeta");
    }
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    for (const createData of createManyData) {
      const record = this._removeNestedCreateData(await this._fillDefaults(createData, tx));
      const keyPath = await tx.objectStore("Todo").add(record);
      await this.emit("create", keyPath, undefined, record, { silent, addToOutbox, tx });
    }
    return { count: createManyData.length };
  }
  async createManyAndReturn<Q extends Prisma.Args<Prisma.TodoDelegate, "createManyAndReturn">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "createManyAndReturn">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const createManyData = IDBUtils.convertToArray(query.data);
    const records: Prisma.Result<Prisma.TodoDelegate, object, "findMany"> = [];
    const storesNeeded: Set<StoreNames<PrismaIDBSchema>> = new Set(["Todo"]);
    if (addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      storesNeeded.add("OutboxEvent");
      storesNeeded.add("VersionMeta");
    }
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    for (const createData of createManyData) {
      const record = this._removeNestedCreateData(await this._fillDefaults(createData, tx));
      const keyPath = await tx.objectStore("Todo").add(record);
      await this.emit("create", keyPath, undefined, record, { silent, addToOutbox, tx });
      records.push(this._applySelectClause([record], query.select)[0]);
    }
    this._preprocessListFields(records);
    return records as Prisma.Result<Prisma.TodoDelegate, Q, "createManyAndReturn">;
  }
  async delete<Q extends Prisma.Args<Prisma.TodoDelegate, "delete">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "delete">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForFind(query);
    this._getNeededStoresForNestedDelete(storesNeeded);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    let recordForDelete: Prisma.Result<Prisma.TodoDelegate, object, "findFirstOrThrow">;
    try {
      recordForDelete = (await this.findUniqueOrThrow({ where: query.where }, { tx })) as Prisma.Result<
        Prisma.TodoDelegate,
        object,
        "findFirstOrThrow"
      >;
    } catch (e) {
      tx.abort();
      throw e;
    }
    const projectionRecord = structuredClone(recordForDelete);
    const recordsWithRelations = await this._applyRelations([projectionRecord], tx, query);
    const record = this._applySelectClause(recordsWithRelations, query.select)[0];
    this._preprocessListFields([record]);
    await this._deleteRecord(recordForDelete, tx, { silent, addToOutbox });
    return record as Prisma.Result<Prisma.TodoDelegate, Q, "delete">;
  }
  async deleteMany<Q extends Prisma.Args<Prisma.TodoDelegate, "deleteMany">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "deleteMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForFind(query);
    this._getNeededStoresForNestedDelete(storesNeeded);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    const records = await this.findMany(query, { tx });
    await Promise.all(records.map((record) => this._deleteRecord(record, tx, { silent, addToOutbox })));
    return { count: records.length };
  }
  async update<Q extends Prisma.Args<Prisma.TodoDelegate, "update">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "update">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForUpdate(query)), "readwrite");
    const record = await this.findUnique({ where: query.where }, { tx });
    if (record === null) {
      tx.abort();
      throw new Error("Record not found");
    }
    const keyPath = await this._updateRecord(record, query, tx, { silent, addToOutbox });
    const recordWithRelations = (await this.findUnique(
      {
        where: { id: keyPath[0] },
        select: query.select,
        ...("include" in query ? { include: query.include } : {}),
      },
      { tx }
    ))!;
    return recordWithRelations as Prisma.Result<Prisma.TodoDelegate, Q, "update">;
  }
  async updateMany<Q extends Prisma.Args<Prisma.TodoDelegate, "updateMany">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "updateMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    tx =
      tx ??
      this.client._db.transaction(
        Array.from(this._getNeededStoresForUpdate(query as unknown as Prisma.Args<Prisma.TodoDelegate, "update">)),
        "readwrite"
      );
    const records = await this.findMany({ where: query.where }, { tx });
    for (const record of records) {
      const updateQuery = {
        where: { id: record.id },
        data: query.data,
      } as Prisma.Args<Prisma.TodoDelegate, "update">;
      await this._updateRecord(record, updateQuery, tx, { silent, addToOutbox });
    }
    return { count: records.length };
  }
  async upsert<Q extends Prisma.Args<Prisma.TodoDelegate, "upsert">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "upsert">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const neededStores = this._getNeededStoresForUpdate({
      ...query,
      data: { ...query.update, ...query.create } as Prisma.Args<Prisma.TodoDelegate, "update">["data"],
    });
    tx = tx ?? this.client._db.transaction(Array.from(neededStores), "readwrite");
    let record = await this.findUnique({ where: query.where }, { tx });
    if (!record) record = await this.create({ data: query.create }, { tx, silent, addToOutbox });
    else record = await this.update({ where: query.where, data: query.update }, { tx, silent, addToOutbox });
    record = await this.findUniqueOrThrow(
      { where: { id: record.id }, select: query.select, include: query.include },
      { tx }
    );
    return record as Prisma.Result<Prisma.TodoDelegate, Q, "upsert">;
  }
  async aggregate<Q extends Prisma.Args<Prisma.TodoDelegate, "aggregate">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.TodoDelegate, Q, "aggregate">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(["Todo"], "readonly");
    const records = await this.findMany({ where: query?.where }, { tx });
    const result: Partial<Prisma.Result<Prisma.TodoDelegate, Q, "aggregate">> = {};
    if (query?._count) {
      if (query._count === true) {
        (result._count as number) = records.length;
      } else {
        for (const key of Object.keys(query._count)) {
          const typedKey = key as keyof typeof query._count;
          if (typedKey === "_all") {
            (result._count as Record<string, number>)[typedKey] = records.length;
            continue;
          }
          (result._count as Record<string, number>)[typedKey] = (
            await this.findMany({ where: { [`${typedKey}`]: { not: null } } }, { tx })
          ).length;
        }
      }
    }
    if (query?._min) {
      const minResult = {} as Prisma.Result<Prisma.TodoDelegate, Q, "aggregate">["_min"];
      const dateTimeFields = ["createdAt"] as const;
      for (const field of dateTimeFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field]?.getTime()).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as Date) = new Date(Math.min(...values));
      }
      const stringFields = ["id", "title", "description", "boardId"] as const;
      for (const field of stringFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field] as string).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as string) = values.sort()[0];
      }
      const booleanFields = ["isCompleted"] as const;
      for (const field of booleanFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field] as boolean).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as boolean) =
          values.length === 0 ? false : values.includes(false) ? false : true;
      }
      result._min = minResult;
    }
    if (query?._max) {
      const maxResult = {} as Prisma.Result<Prisma.TodoDelegate, Q, "aggregate">["_max"];
      const dateTimeFields = ["createdAt"] as const;
      for (const field of dateTimeFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field]?.getTime()).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as Date) = new Date(Math.max(...values));
      }
      const stringFields = ["id", "title", "description", "boardId"] as const;
      for (const field of stringFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field] as string).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as string) = values.sort().reverse()[0];
      }
      const booleanFields = ["isCompleted"] as const;
      for (const field of booleanFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field] as boolean).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as boolean) = values.length === 0 ? false : values.includes(true);
      }
      result._max = maxResult;
    }
    return result as unknown as Prisma.Result<Prisma.TodoDelegate, Q, "aggregate">;
  }
}
class UserIDBClass extends BaseIDBModelClass<"User"> {
  constructor(client: PrismaIDBClient, keyPath: string[]) {
    super(client, keyPath, "User");
  }

  private async _applyWhereClause<
    W extends Prisma.Args<Prisma.UserDelegate, "findFirstOrThrow">["where"],
    R extends Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">,
  >(records: R[], whereClause: W, tx: IDBUtils.TransactionType): Promise<R[]> {
    if (!whereClause) return records;
    records = await IDBUtils.applyLogicalFilters<Prisma.UserDelegate, R, W>(
      records,
      whereClause,
      tx,
      this.keyPath,
      this._applyWhereClause.bind(this)
    );
    return (
      await Promise.all(
        records.map(async (record) => {
          const stringFields = ["id", "name", "email", "image"] as const;
          for (const field of stringFields) {
            if (!IDBUtils.whereStringFilter(record, field, whereClause[field])) return null;
          }
          const booleanFields = ["emailVerified", "isAnonymous"] as const;
          for (const field of booleanFields) {
            if (!IDBUtils.whereBoolFilter(record, field, whereClause[field])) return null;
          }
          const dateTimeFields = ["createdAt", "updatedAt"] as const;
          for (const field of dateTimeFields) {
            if (!IDBUtils.whereDateTimeFilter(record, field, whereClause[field])) return null;
          }
          if (whereClause.boards) {
            if (whereClause.boards.every) {
              const violatingRecord = await this.client.board.findFirst(
                {
                  where: { NOT: { ...whereClause.boards.every }, userId: record.id },
                },
                { tx }
              );
              if (violatingRecord !== null) return null;
            }
            if (whereClause.boards.some) {
              const relatedRecords = await this.client.board.findMany(
                {
                  where: { ...whereClause.boards.some, userId: record.id },
                },
                { tx }
              );
              if (relatedRecords.length === 0) return null;
            }
            if (whereClause.boards.none) {
              const violatingRecord = await this.client.board.findFirst(
                {
                  where: { ...whereClause.boards.none, userId: record.id },
                },
                { tx }
              );
              if (violatingRecord !== null) return null;
            }
          }
          return record;
        })
      )
    ).filter((result) => result !== null);
  }
  private _applySelectClause<S extends Prisma.Args<Prisma.UserDelegate, "findMany">["select"]>(
    records: Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">[],
    selectClause: S
  ): Prisma.Result<Prisma.UserDelegate, { select: S }, "findFirstOrThrow">[] {
    if (!selectClause) {
      return records as Prisma.Result<Prisma.UserDelegate, { select: S }, "findFirstOrThrow">[];
    }
    return records.map((record) => {
      const partialRecord: Partial<typeof record> = { ...record };
      for (const untypedKey of [
        "id",
        "name",
        "email",
        "emailVerified",
        "image",
        "createdAt",
        "updatedAt",
        "isAnonymous",
        "boards",
      ]) {
        const key = untypedKey as keyof typeof record & keyof S;
        if (!selectClause[key]) delete partialRecord[key];
      }
      return partialRecord;
    }) as Prisma.Result<Prisma.UserDelegate, { select: S }, "findFirstOrThrow">[];
  }
  private async _applyRelations<Q extends Prisma.Args<Prisma.UserDelegate, "findMany">>(
    records: Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">[],
    tx: IDBUtils.TransactionType,
    query?: Q
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "findFirstOrThrow">[]> {
    if (!query) return records as Prisma.Result<Prisma.UserDelegate, Q, "findFirstOrThrow">[];
    const attach_boards = query.select?.boards || query.include?.boards;
    if (!attach_boards) return records as Prisma.Result<Prisma.UserDelegate, Q, "findFirstOrThrow">[];
    let boards_hashMap: Map<string, unknown[]> | undefined;
    if (attach_boards) {
      const boards_opts = (attach_boards === true ? {} : attach_boards) as Record<string, unknown>;
      const boards_sel = boards_opts.select as Record<string, boolean> | undefined;
      const boards_keysToInject = boards_sel ? (["userId"] as string[]).filter((k) => !boards_sel![k]) : [];
      const boards_take = boards_opts.take as number | undefined;
      const boards_skip = boards_opts.skip as number | undefined;
      const boards_cursor = boards_opts.cursor;
      const boards_distinct = boards_opts.distinct;
      const boards_parentIds = [...new Set(records.map((r) => r.id))];
      boards_hashMap = new Map<string, unknown[]>();
      const boards_userWhere = boards_opts.where as Record<string, unknown> | undefined;
      if (boards_cursor !== undefined || boards_distinct !== undefined) {
        for (const parentId of boards_parentIds) {
          const boards_perParentFkWhere = { userId: parentId };
          const boards_perParentWhere = boards_userWhere
            ? { AND: [boards_userWhere, boards_perParentFkWhere] }
            : boards_perParentFkWhere;
          const children = await this.client.board.findMany(
            {
              ...boards_opts,
              ...(boards_keysToInject.length > 0
                ? { select: { ...boards_sel, ...Object.fromEntries(boards_keysToInject.map((k) => [k, true])) } }
                : {}),
              where: boards_perParentWhere,
            },
            { tx }
          );
          const stripped = children.map((c) => {
            const _r = c as Record<string, unknown>;
            return boards_keysToInject.length > 0
              ? Object.fromEntries(Object.entries(_r).filter(([k]) => !boards_keysToInject.includes(k)))
              : _r;
          });
          boards_hashMap!.set(JSON.stringify(parentId), stripped as unknown[]);
        }
      } else {
        const boards_fkWhere = { userId: { in: boards_parentIds } };
        const boards_where = boards_userWhere ? { AND: [boards_userWhere, boards_fkWhere] } : boards_fkWhere;
        const boards_allRelated = await this.client.board.findMany(
          {
            ...boards_opts,
            ...(boards_keysToInject.length > 0
              ? { select: { ...boards_sel, ...Object.fromEntries(boards_keysToInject.map((k) => [k, true])) } }
              : {}),
            take: undefined,
            skip: undefined,
            where: boards_where,
          },
          { tx }
        );
        for (const related of boards_allRelated) {
          const _r = related as Record<string, unknown>;
          const key = JSON.stringify(_r["userId"]);
          if (!boards_hashMap!.has(key)) boards_hashMap!.set(key, []);
          const value =
            boards_keysToInject.length > 0
              ? Object.fromEntries(Object.entries(_r).filter(([k]) => !boards_keysToInject.includes(k)))
              : _r;
          boards_hashMap!.get(key)!.push(value as unknown);
        }
        if (boards_skip !== undefined || boards_take !== undefined) {
          if (boards_skip !== undefined && (!Number.isInteger(boards_skip) || boards_skip < 0))
            throw new Error("skip must be a non-negative integer");
          if (boards_take !== undefined && !Number.isInteger(boards_take)) throw new Error("take must be an integer");
          for (const [key, group] of boards_hashMap!) {
            let sliced = group;
            if (boards_skip !== undefined) sliced = sliced.slice(boards_skip);
            if (boards_take !== undefined)
              sliced = boards_take < 0 ? sliced.slice(boards_take) : sliced.slice(0, boards_take);
            boards_hashMap!.set(key, sliced);
          }
        }
      }
    }
    const recordsWithRelations = records.map((record) => {
      const unsafeRecord = record as Record<string, unknown>;
      if (attach_boards) {
        unsafeRecord["boards"] = (() => {
          const _v = boards_hashMap!.get(JSON.stringify(record.id));
          return _v == null ? [] : structuredClone(_v);
        })();
      }
      return unsafeRecord;
    });
    return recordsWithRelations as Prisma.Result<Prisma.UserDelegate, Q, "findFirstOrThrow">[];
  }
  async _applyOrderByClause<
    O extends Prisma.Args<Prisma.UserDelegate, "findMany">["orderBy"],
    R extends Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">,
  >(records: R[], orderByClause: O, tx: IDBUtils.TransactionType): Promise<void> {
    if (orderByClause === undefined) return;
    const orderByClauses = IDBUtils.convertToArray(orderByClause);
    const indexedKeys = await Promise.all(
      records.map(async (record) => {
        const keys = await Promise.all(
          orderByClauses.map(async (clause) => await this._resolveOrderByKey(record, clause, tx))
        );
        return { keys, record };
      })
    );
    indexedKeys.sort((a, b) => {
      for (let i = 0; i < orderByClauses.length; i++) {
        const clause = orderByClauses[i];
        const comparison = IDBUtils.genericComparator(a.keys[i], b.keys[i], this._resolveSortOrder(clause));
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
    for (let i = 0; i < records.length; i++) {
      records[i] = indexedKeys[i].record;
    }
  }
  async _resolveOrderByKey(
    record: Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">,
    orderByInput: Prisma.UserOrderByWithRelationInput,
    tx: IDBUtils.TransactionType
  ): Promise<unknown> {
    const scalarFields = [
      "id",
      "name",
      "email",
      "emailVerified",
      "image",
      "createdAt",
      "updatedAt",
      "isAnonymous",
    ] as const;
    for (const field of scalarFields) if (orderByInput[field]) return record[field];
    if (orderByInput.boards) {
      return await this.client.board.count({ where: { userId: record.id } }, { tx });
    }
  }
  _resolveSortOrder(
    orderByInput: Prisma.UserOrderByWithRelationInput
  ): Prisma.SortOrder | { sort: Prisma.SortOrder; nulls?: "first" | "last" } {
    const scalarFields = [
      "id",
      "name",
      "email",
      "emailVerified",
      "image",
      "createdAt",
      "updatedAt",
      "isAnonymous",
    ] as const;
    for (const field of scalarFields) if (orderByInput[field]) return orderByInput[field];
    if (orderByInput.boards?._count) {
      return orderByInput.boards._count;
    }
    throw new Error("No field in orderBy clause");
  }
  private async _fillDefaults<D extends Prisma.Args<Prisma.UserDelegate, "create">["data"]>(
    data: D,
    tx?: IDBUtils.ReadwriteTransactionType
  ): Promise<D> {
    if (data === undefined) data = {} as NonNullable<D>;
    if (data.emailVerified === undefined) {
      data.emailVerified = false;
    }
    if (data.image === undefined) {
      data.image = null;
    }
    if (data.createdAt === undefined) {
      data.createdAt = new Date();
    }
    if (data.isAnonymous === undefined) {
      data.isAnonymous = null;
    }
    if (typeof data.createdAt === "string") {
      data.createdAt = new Date(data.createdAt);
    }
    if (typeof data.updatedAt === "string") {
      data.updatedAt = new Date(data.updatedAt);
    }
    return data;
  }
  _getNeededStoresForWhere<W extends Prisma.Args<Prisma.UserDelegate, "findMany">["where"]>(
    whereClause: W,
    neededStores: Set<StoreNames<PrismaIDBSchema>>
  ) {
    if (whereClause === undefined) return;
    for (const param of IDBUtils.LogicalParams) {
      if (whereClause[param]) {
        for (const clause of IDBUtils.convertToArray(whereClause[param])) {
          this._getNeededStoresForWhere(clause, neededStores);
        }
      }
    }
    if (whereClause.boards) {
      neededStores.add("Board");
      this.client.board._getNeededStoresForWhere(whereClause.boards.every, neededStores);
      this.client.board._getNeededStoresForWhere(whereClause.boards.some, neededStores);
      this.client.board._getNeededStoresForWhere(whereClause.boards.none, neededStores);
    }
  }
  _getNeededStoresForFind<Q extends Prisma.Args<Prisma.UserDelegate, "findMany">>(
    query?: Q
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores: Set<StoreNames<PrismaIDBSchema>> = new Set();
    neededStores.add("User");
    this._getNeededStoresForWhere(query?.where, neededStores);
    if (query?.orderBy) {
      const orderBy = IDBUtils.convertToArray(query.orderBy);
      const orderBy_boards = orderBy.find((clause) => clause.boards);
      if (orderBy_boards) {
        neededStores.add("Board");
      }
    }
    if (query?.select?.boards || query?.include?.boards) {
      neededStores.add("Board");
      if (typeof query.select?.boards === "object") {
        this.client.board
          ._getNeededStoresForFind(query.select.boards)
          .forEach((storeName) => neededStores.add(storeName));
      }
      if (typeof query.include?.boards === "object") {
        this.client.board
          ._getNeededStoresForFind(query.include.boards)
          .forEach((storeName) => neededStores.add(storeName));
      }
    }
    return neededStores;
  }
  _getNeededStoresForCreate<D extends Partial<Prisma.Args<Prisma.UserDelegate, "create">["data"]>>(
    data: D
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores: Set<StoreNames<PrismaIDBSchema>> = new Set();
    neededStores.add("User");
    if (data?.boards) {
      neededStores.add("Board");
      if (data.boards.create) {
        const createData = Array.isArray(data.boards.create) ? data.boards.create : [data.boards.create];
        createData.forEach((record) =>
          this.client.board._getNeededStoresForCreate(record).forEach((storeName) => neededStores.add(storeName))
        );
      }
      if (data.boards.connectOrCreate) {
        IDBUtils.convertToArray(data.boards.connectOrCreate).forEach((record) =>
          this.client.board._getNeededStoresForCreate(record.create).forEach((storeName) => neededStores.add(storeName))
        );
      }
      if (data.boards.createMany) {
        IDBUtils.convertToArray(data.boards.createMany.data).forEach((record) =>
          this.client.board._getNeededStoresForCreate(record).forEach((storeName) => neededStores.add(storeName))
        );
      }
    }
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
    return neededStores;
  }
  _getNeededStoresForUpdate<Q extends Prisma.Args<Prisma.UserDelegate, "update">>(
    query: Partial<Q>
  ): Set<StoreNames<PrismaIDBSchema>> {
    const neededStores = this._getNeededStoresForFind(query).union(
      this._getNeededStoresForCreate(query.data as Prisma.Args<Prisma.UserDelegate, "create">["data"])
    );
    if (query.data?.boards?.connect) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.boards.connect).forEach((connect) => {
        this.client.board._getNeededStoresForWhere(connect, neededStores);
      });
    }
    if (query.data?.boards?.set) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.boards.set).forEach((setWhere) => {
        this.client.board._getNeededStoresForWhere(setWhere, neededStores);
      });
    }
    if (query.data?.boards?.updateMany) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.boards.updateMany).forEach((update) => {
        this.client.board
          ._getNeededStoresForUpdate(update as Prisma.Args<Prisma.BoardDelegate, "update">)
          .forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.boards?.update) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.boards.update).forEach((update) => {
        const normalizedUpdate = { ...update, data: update.data ?? update } as Prisma.Args<
          Prisma.BoardDelegate,
          "update"
        >;
        this.client.board._getNeededStoresForUpdate(normalizedUpdate).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.boards?.upsert) {
      neededStores.add("Board");
      IDBUtils.convertToArray(query.data.boards.upsert).forEach((upsert) => {
        const update = { where: upsert.where, data: { ...upsert.update, ...upsert.create } } as Prisma.Args<
          Prisma.BoardDelegate,
          "update"
        >;
        this.client.board._getNeededStoresForUpdate(update).forEach((store) => neededStores.add(store));
      });
    }
    if (query.data?.boards?.delete || query.data?.boards?.deleteMany) {
      this.client.board._getNeededStoresForNestedDelete(neededStores);
    }
    if (query.data?.id !== undefined) {
      neededStores.add("Board");
    }
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
    return neededStores;
  }
  _getNeededStoresForNestedDelete(neededStores: Set<StoreNames<PrismaIDBSchema>>): void {
    neededStores.add("User");
    this.client.board._getNeededStoresForNestedDelete(neededStores);
    if (this.client.shouldTrackModel(this.modelName)) {
      neededStores.add("OutboxEvent");
      neededStores.add("VersionMeta");
    }
  }
  private _removeNestedCreateData<D extends Prisma.Args<Prisma.UserDelegate, "create">["data"]>(
    data: D
  ): Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow"> {
    const recordWithoutNestedCreate = structuredClone(data);
    delete recordWithoutNestedCreate?.boards;
    return recordWithoutNestedCreate as Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">;
  }
  private _preprocessListFields(records: Prisma.Result<Prisma.UserDelegate, object, "findMany">): void {}
  private async _getRecords(
    tx: IDBUtils.TransactionType,
    where?: Prisma.Args<Prisma.UserDelegate, "findFirstOrThrow">["where"]
  ): Promise<Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">[]> {
    if (!where) return tx.objectStore("User").getAll();
    const emailEq = IDBUtils.extractEqualityValue(where.email);

    if (emailEq !== undefined) {
      return tx
        .objectStore("User")
        .index("emailIndex")
        .getAll(IDBUtils.IDBKeyRange.only([emailEq]));
    }

    return tx.objectStore("User").getAll();
  }
  private async _deleteRecord(
    record: Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">,
    tx: IDBUtils.ReadwriteTransactionType,
    options?: { silent?: boolean; addToOutbox?: boolean }
  ): Promise<void> {
    const { silent = false, addToOutbox = true } = options ?? {};
    await this.client.board.deleteMany(
      {
        where: { userId: record.id },
      },
      { tx, silent, addToOutbox }
    );
    await tx.objectStore("User").delete([record.id]);
    await this.emit("delete", [record.id], undefined, record, { silent, addToOutbox, tx });
  }
  private async _updateRecord<Q extends Prisma.Args<Prisma.UserDelegate, "update">>(
    record: Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">,
    query: Q,
    tx: IDBUtils.ReadwriteTransactionType,
    options?: { silent?: boolean; addToOutbox?: boolean }
  ): Promise<PrismaIDBSchema["User"]["key"]> {
    const { silent = false, addToOutbox = true } = options ?? {};
    const startKeyPath: PrismaIDBSchema["User"]["key"] = [record.id];
    if (query.data.boards) {
      if (query.data.boards.connect) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.connect).map(async (connectWhere) => {
            await this.client.board.update(
              { where: connectWhere, data: { userId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.boards.disconnect) {
        tx.abort();
        throw new Error("Cannot disconnect required relation");
      }
      if (query.data.boards.create) {
        const createData = Array.isArray(query.data.boards.create)
          ? query.data.boards.create
          : [query.data.boards.create];
        for (const elem of createData) {
          await this.client.board.create(
            { data: { ...elem, userId: record.id } as Prisma.Args<Prisma.BoardDelegate, "create">["data"] },
            { tx, silent, addToOutbox }
          );
        }
      }
      if (query.data.boards.createMany) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.createMany.data).map(async (createData) => {
            await this.client.board.create({ data: { ...createData, userId: record.id } }, { tx, silent, addToOutbox });
          })
        );
      }
      if (query.data.boards.update) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.update).map(async (updateData) => {
            await this.client.board.update(
              { ...updateData, where: { ...updateData.where, userId: record.id } as Prisma.BoardWhereUniqueInput },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.boards.updateMany) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.updateMany).map(async (updateData) => {
            await this.client.board.updateMany(
              { ...updateData, where: { ...updateData.where, userId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.boards.upsert) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.upsert).map(async (upsertData) => {
            await this.client.board.upsert(
              {
                ...upsertData,
                where: { ...upsertData.where, userId: record.id },
                create: { ...upsertData.create, userId: record.id } as Prisma.Args<
                  Prisma.BoardDelegate,
                  "upsert"
                >["create"],
              },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.boards.delete) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.delete).map(async (deleteData) => {
            await this.client.board.delete(
              { where: { ...deleteData, userId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.boards.deleteMany) {
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.deleteMany).map(async (deleteData) => {
            await this.client.board.deleteMany(
              { where: { ...deleteData, userId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
      if (query.data.boards.set) {
        const existing = await this.client.board.findMany({ where: { userId: record.id } }, { tx });
        if (existing.length > 0) {
          tx.abort();
          throw new Error("Cannot set required relation");
        }
        await Promise.all(
          IDBUtils.convertToArray(query.data.boards.set).map(async (setData) => {
            await this.client.board.update(
              { where: setData, data: { userId: record.id } },
              { tx, silent, addToOutbox }
            );
          })
        );
      }
    }
    const stringFields = ["id", "name", "email", "image"] as const;
    for (const field of stringFields) {
      IDBUtils.handleStringUpdateField(record, field, query.data[field]);
    }
    const dateTimeFields = ["createdAt", "updatedAt"] as const;
    for (const field of dateTimeFields) {
      IDBUtils.handleDateTimeUpdateField(record, field, query.data[field]);
    }
    const booleanFields = ["emailVerified", "isAnonymous"] as const;
    for (const field of booleanFields) {
      IDBUtils.handleBooleanUpdateField(record, field, query.data[field]);
    }
    const endKeyPath: PrismaIDBSchema["User"]["key"] = [record.id];
    for (let i = 0; i < startKeyPath.length; i++) {
      if (startKeyPath[i] !== endKeyPath[i]) {
        if ((await tx.objectStore("User").get(endKeyPath)) !== undefined) {
          tx.abort();
          throw new Error("Record with the same keyPath already exists");
        }
        await tx.objectStore("User").delete(startKeyPath);
        break;
      }
    }
    const keyPath = await tx.objectStore("User").put(record);
    await this.emit("update", keyPath, startKeyPath, record, { silent, addToOutbox, tx });
    for (let i = 0; i < startKeyPath.length; i++) {
      if (startKeyPath[i] !== endKeyPath[i]) {
        await this.client.board.updateMany(
          {
            where: { userId: startKeyPath[0] },
            data: { userId: endKeyPath[0] },
          },
          { tx, silent, addToOutbox }
        );
        break;
      }
    }
    return keyPath;
  }
  async findMany<Q extends Prisma.Args<Prisma.UserDelegate, "findMany">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "findMany">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    let records = await this._applyWhereClause(await this._getRecords(tx, query?.where), query?.where, tx);
    await this._applyOrderByClause(records, query?.orderBy, tx);
    if (query?.distinct) {
      const distinctFields = IDBUtils.convertToArray(query.distinct);
      const seen = new Set<string>();
      records = records.filter((record) => {
        const values = distinctFields.map((field) => record[field]);
        const key = JSON.stringify(values);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (query?.skip !== undefined) {
      if (!Number.isInteger(query.skip) || query.skip < 0) {
        throw new Error("skip must be a non-negative integer");
      }
    }
    if (query?.take !== undefined) {
      if (!Number.isInteger(query.take)) {
        throw new Error("take must be an integer");
      }
    }
    if (query?.cursor) {
      let cursorIndex = -1;
      if ((query.cursor as Record<string, unknown>)["id"] !== undefined) {
        const normalizedCursor = query.cursor as Record<string, unknown>;
        cursorIndex = records.findIndex((record) => record.id === normalizedCursor.id);
      } else if ((query.cursor as Record<string, unknown>)["email"] !== undefined) {
        const normalizedCursor = query.cursor as Record<string, unknown>;
        cursorIndex = records.findIndex((record) => record.email === normalizedCursor.email);
      }
      if (cursorIndex === -1) {
        records = [];
      } else if (query.take !== undefined && query.take < 0) {
        const skip = query.skip ?? 0;
        const end = cursorIndex + 1 - skip;
        const start = end + query.take;
        records = records.slice(Math.max(0, start), Math.max(0, end));
      } else {
        records = records.slice(cursorIndex);
      }
    }
    if (!(query?.cursor && query?.take !== undefined && query.take < 0)) {
      if (query?.skip !== undefined) {
        records = records.slice(query.skip);
      }
      if (query?.take !== undefined) {
        if (query.take < 0) {
          records = records.slice(query.take);
        } else {
          records = records.slice(0, query.take);
        }
      }
    }
    const relationAppliedRecords = (await this._applyRelations(records, tx, query)) as Prisma.Result<
      Prisma.UserDelegate,
      object,
      "findFirstOrThrow"
    >[];
    const selectClause = query?.select;
    const selectAppliedRecords = this._applySelectClause(relationAppliedRecords, selectClause);
    this._preprocessListFields(selectAppliedRecords);
    return selectAppliedRecords as Prisma.Result<Prisma.UserDelegate, Q, "findMany">;
  }
  async findFirst<Q extends Prisma.Args<Prisma.UserDelegate, "findFirst">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "findFirst">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    return (await this.findMany(query, { tx }))[0] ?? null;
  }
  async findFirstOrThrow<Q extends Prisma.Args<Prisma.UserDelegate, "findFirstOrThrow">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "findFirstOrThrow">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    const record = await this.findFirst(query, { tx });
    if (!record) {
      throw new Error("Record not found");
    }
    return record;
  }
  async findUnique<Q extends Prisma.Args<Prisma.UserDelegate, "findUnique">>(
    query: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "findUnique">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    let record;
    if (query.where.id !== undefined) {
      record = await tx.objectStore("User").get([query.where.id]);
    } else if (query.where.email !== undefined) {
      record = await tx.objectStore("User").index("emailIndex").get([query.where.email]);
    }
    if (!record) return null;

    const recordWithRelations = this._applySelectClause(
      await this._applyRelations(await this._applyWhereClause([record], query.where, tx), tx, query),
      query.select
    )[0];
    this._preprocessListFields([recordWithRelations]);
    return recordWithRelations as Prisma.Result<Prisma.UserDelegate, Q, "findUnique">;
  }
  async findUniqueOrThrow<Q extends Prisma.Args<Prisma.UserDelegate, "findUniqueOrThrow">>(
    query: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "findUniqueOrThrow">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForFind(query)), "readonly");
    const record = await this.findUnique(query, { tx });
    if (!record) {
      throw new Error("Record not found");
    }
    return record;
  }
  async count<Q extends Prisma.Args<Prisma.UserDelegate, "count">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "count">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;

    tx = tx ?? this.client._db.transaction(["User"], "readonly");
    if (!query?.select || query.select === true) {
      const records = await this.findMany({ where: query?.where }, { tx });
      return records.length as Prisma.Result<Prisma.UserDelegate, Q, "count">;
    }
    const result: Partial<Record<keyof Prisma.UserCountAggregateInputType, number>> = {};
    for (const key of Object.keys(query.select)) {
      const typedKey = key as keyof typeof query.select;
      if (typedKey === "_all") {
        result[typedKey] = (await this.findMany({ where: query.where }, { tx })).length;
        continue;
      }
      result[typedKey] = (await this.findMany({ where: { [`${typedKey}`]: { not: null } } }, { tx })).length;
    }
    return result as Prisma.Result<Prisma.UserDelegate, Q, "count">;
  }
  async create<Q extends Prisma.Args<Prisma.UserDelegate, "create">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "create">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForCreate(query.data);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    const record = this._removeNestedCreateData(await this._fillDefaults(query.data, tx));
    const keyPath = await tx.objectStore("User").add(record);
    if (query.data?.boards?.create) {
      for (const elem of IDBUtils.convertToArray(query.data.boards.create)) {
        await this.client.board.create(
          {
            data: { ...elem, user: { connect: { id: keyPath[0] } } } as Prisma.Args<
              Prisma.BoardDelegate,
              "create"
            >["data"],
          },
          { tx, silent, addToOutbox }
        );
      }
    }
    if (query.data?.boards?.connect) {
      await Promise.all(
        IDBUtils.convertToArray(query.data.boards.connect).map(async (connectWhere) => {
          await this.client.board.update(
            { where: connectWhere, data: { userId: keyPath[0] } },
            { tx, silent, addToOutbox }
          );
        })
      );
    }
    if (query.data?.boards?.connectOrCreate) {
      await Promise.all(
        IDBUtils.convertToArray(query.data.boards.connectOrCreate).map(async (connectOrCreate) => {
          await this.client.board.upsert(
            {
              where: connectOrCreate.where,
              create: { ...connectOrCreate.create, userId: keyPath[0] } as NonNullable<
                Prisma.Args<Prisma.BoardDelegate, "create">["data"]
              >,
              update: { userId: keyPath[0] },
            },
            { tx, silent, addToOutbox }
          );
        })
      );
    }
    if (query.data?.boards?.createMany) {
      await this.client.board.createMany(
        {
          data: IDBUtils.convertToArray(query.data.boards.createMany.data).map((createData) => ({
            ...createData,
            userId: keyPath[0],
          })),
        },
        { tx, silent, addToOutbox }
      );
    }
    const data = (await tx.objectStore("User").get(keyPath))!;
    const recordsWithRelations = this._applySelectClause(
      await this._applyRelations<object>([data], tx, query),
      query.select
    )[0];
    this._preprocessListFields([recordsWithRelations]);
    await this.emit("create", keyPath, undefined, data, { silent, addToOutbox, tx });
    return recordsWithRelations as Prisma.Result<Prisma.UserDelegate, Q, "create">;
  }
  async createMany<Q extends Prisma.Args<Prisma.UserDelegate, "createMany">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "createMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const createManyData = IDBUtils.convertToArray(query.data);
    const storesNeeded: Set<StoreNames<PrismaIDBSchema>> = new Set(["User"]);
    if (addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      storesNeeded.add("OutboxEvent");
      storesNeeded.add("VersionMeta");
    }
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    for (const createData of createManyData) {
      const record = this._removeNestedCreateData(await this._fillDefaults(createData, tx));
      const keyPath = await tx.objectStore("User").add(record);
      await this.emit("create", keyPath, undefined, record, { silent, addToOutbox, tx });
    }
    return { count: createManyData.length };
  }
  async createManyAndReturn<Q extends Prisma.Args<Prisma.UserDelegate, "createManyAndReturn">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "createManyAndReturn">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const createManyData = IDBUtils.convertToArray(query.data);
    const records: Prisma.Result<Prisma.UserDelegate, object, "findMany"> = [];
    const storesNeeded: Set<StoreNames<PrismaIDBSchema>> = new Set(["User"]);
    if (addToOutbox !== false && this.client.shouldTrackModel(this.modelName)) {
      storesNeeded.add("OutboxEvent");
      storesNeeded.add("VersionMeta");
    }
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    for (const createData of createManyData) {
      const record = this._removeNestedCreateData(await this._fillDefaults(createData, tx));
      const keyPath = await tx.objectStore("User").add(record);
      await this.emit("create", keyPath, undefined, record, { silent, addToOutbox, tx });
      records.push(this._applySelectClause([record], query.select)[0]);
    }
    this._preprocessListFields(records);
    return records as Prisma.Result<Prisma.UserDelegate, Q, "createManyAndReturn">;
  }
  async delete<Q extends Prisma.Args<Prisma.UserDelegate, "delete">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "delete">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForFind(query);
    this._getNeededStoresForNestedDelete(storesNeeded);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    let recordForDelete: Prisma.Result<Prisma.UserDelegate, object, "findFirstOrThrow">;
    try {
      recordForDelete = (await this.findUniqueOrThrow({ where: query.where }, { tx })) as Prisma.Result<
        Prisma.UserDelegate,
        object,
        "findFirstOrThrow"
      >;
    } catch (e) {
      tx.abort();
      throw e;
    }
    const projectionRecord = structuredClone(recordForDelete);
    const recordsWithRelations = await this._applyRelations([projectionRecord], tx, query);
    const record = this._applySelectClause(recordsWithRelations, query.select)[0];
    this._preprocessListFields([record]);
    await this._deleteRecord(recordForDelete, tx, { silent, addToOutbox });
    return record as Prisma.Result<Prisma.UserDelegate, Q, "delete">;
  }
  async deleteMany<Q extends Prisma.Args<Prisma.UserDelegate, "deleteMany">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "deleteMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const storesNeeded = this._getNeededStoresForFind(query);
    this._getNeededStoresForNestedDelete(storesNeeded);
    tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");
    const records = await this.findMany(query, { tx });
    await Promise.all(records.map((record) => this._deleteRecord(record, tx, { silent, addToOutbox })));
    return { count: records.length };
  }
  async update<Q extends Prisma.Args<Prisma.UserDelegate, "update">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "update">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(Array.from(this._getNeededStoresForUpdate(query)), "readwrite");
    const record = await this.findUnique({ where: query.where }, { tx });
    if (record === null) {
      tx.abort();
      throw new Error("Record not found");
    }
    const keyPath = await this._updateRecord(record, query, tx, { silent, addToOutbox });
    const recordWithRelations = (await this.findUnique(
      {
        where: { id: keyPath[0] },
        select: query.select,
        ...("include" in query ? { include: query.include } : {}),
      },
      { tx }
    ))!;
    return recordWithRelations as Prisma.Result<Prisma.UserDelegate, Q, "update">;
  }
  async updateMany<Q extends Prisma.Args<Prisma.UserDelegate, "updateMany">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "updateMany">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    tx =
      tx ??
      this.client._db.transaction(
        Array.from(this._getNeededStoresForUpdate(query as unknown as Prisma.Args<Prisma.UserDelegate, "update">)),
        "readwrite"
      );
    const records = await this.findMany({ where: query.where }, { tx });
    for (const record of records) {
      const updateQuery = {
        where: { id: record.id },
        data: query.data,
      } as Prisma.Args<Prisma.UserDelegate, "update">;
      await this._updateRecord(record, updateQuery, tx, { silent, addToOutbox });
    }
    return { count: records.length };
  }
  async upsert<Q extends Prisma.Args<Prisma.UserDelegate, "upsert">>(
    query: Q,
    options?: {
      tx?: IDBUtils.ReadwriteTransactionType;
      silent?: boolean;
      addToOutbox?: boolean;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "upsert">> {
    const { tx: txOption, silent = false, addToOutbox = true } = options ?? {};
    let tx = txOption;
    const neededStores = this._getNeededStoresForUpdate({
      ...query,
      data: { ...query.update, ...query.create } as Prisma.Args<Prisma.UserDelegate, "update">["data"],
    });
    tx = tx ?? this.client._db.transaction(Array.from(neededStores), "readwrite");
    let record = await this.findUnique({ where: query.where }, { tx });
    if (!record) record = await this.create({ data: query.create }, { tx, silent, addToOutbox });
    else record = await this.update({ where: query.where, data: query.update }, { tx, silent, addToOutbox });
    record = await this.findUniqueOrThrow(
      { where: { id: record.id }, select: query.select, include: query.include },
      { tx }
    );
    return record as Prisma.Result<Prisma.UserDelegate, Q, "upsert">;
  }
  async aggregate<Q extends Prisma.Args<Prisma.UserDelegate, "aggregate">>(
    query?: Q,
    options?: {
      tx?: IDBUtils.TransactionType;
    }
  ): Promise<Prisma.Result<Prisma.UserDelegate, Q, "aggregate">> {
    const { tx: txOption } = options ?? {};
    let tx = txOption;
    tx = tx ?? this.client._db.transaction(["User"], "readonly");
    const records = await this.findMany({ where: query?.where }, { tx });
    const result: Partial<Prisma.Result<Prisma.UserDelegate, Q, "aggregate">> = {};
    if (query?._count) {
      if (query._count === true) {
        (result._count as number) = records.length;
      } else {
        for (const key of Object.keys(query._count)) {
          const typedKey = key as keyof typeof query._count;
          if (typedKey === "_all") {
            (result._count as Record<string, number>)[typedKey] = records.length;
            continue;
          }
          (result._count as Record<string, number>)[typedKey] = (
            await this.findMany({ where: { [`${typedKey}`]: { not: null } } }, { tx })
          ).length;
        }
      }
    }
    if (query?._min) {
      const minResult = {} as Prisma.Result<Prisma.UserDelegate, Q, "aggregate">["_min"];
      const dateTimeFields = ["createdAt", "updatedAt"] as const;
      for (const field of dateTimeFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field]?.getTime()).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as Date) = new Date(Math.min(...values));
      }
      const stringFields = ["id", "name", "email", "image"] as const;
      for (const field of stringFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field] as string).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as string) = values.sort()[0];
      }
      const booleanFields = ["emailVerified", "isAnonymous"] as const;
      for (const field of booleanFields) {
        if (!query._min[field]) continue;
        const values = records.map((record) => record[field] as boolean).filter((value) => value !== undefined);
        (minResult[field as keyof typeof minResult] as boolean) =
          values.length === 0 ? false : values.includes(false) ? false : true;
      }
      result._min = minResult;
    }
    if (query?._max) {
      const maxResult = {} as Prisma.Result<Prisma.UserDelegate, Q, "aggregate">["_max"];
      const dateTimeFields = ["createdAt", "updatedAt"] as const;
      for (const field of dateTimeFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field]?.getTime()).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as Date) = new Date(Math.max(...values));
      }
      const stringFields = ["id", "name", "email", "image"] as const;
      for (const field of stringFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field] as string).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as string) = values.sort().reverse()[0];
      }
      const booleanFields = ["emailVerified", "isAnonymous"] as const;
      for (const field of booleanFields) {
        if (!query._max[field]) continue;
        const values = records.map((record) => record[field] as boolean).filter((value) => value !== undefined);
        (maxResult[field as keyof typeof maxResult] as boolean) = values.length === 0 ? false : values.includes(true);
      }
      result._max = maxResult;
    }
    return result as unknown as Prisma.Result<Prisma.UserDelegate, Q, "aggregate">;
  }
}
class OutboxEventIDBClass extends BaseIDBModelClass<"OutboxEvent"> {
  constructor(client: PrismaIDBClient, keyPath: string[]) {
    super(client, keyPath, "OutboxEvent");
  }

  async create(
    query: { data: Pick<OutboxEventRecord, "entityType" | "operation" | "payload"> },
    options?: { tx?: IDBUtils.ReadwriteTransactionType; silent?: boolean }
  ): Promise<OutboxEventRecord> {
    const tx = options?.tx ?? this.client._db.transaction(["OutboxEvent"], "readwrite");
    const store = tx.objectStore("OutboxEvent");

    const event: OutboxEventRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      synced: false,
      syncedAt: null,
      lastAttemptedAt: null,
      tries: 0,
      lastError: null,
      retryable: true,
      ...query.data,
    };
    await store.add(event);

    this.emit("create", [event.id], undefined, event, { silent: options?.silent ?? false, addToOutbox: false, tx });
    if (!options?.tx) await tx.done;

    return event;
  }

  async getNextBatch(options?: { limit?: number }): Promise<OutboxEventRecord[]> {
    const limit = options?.limit ?? 20;
    const tx = this.client._db.transaction(["OutboxEvent"], "readonly");
    const store = tx.objectStore("OutboxEvent");

    // Get all unsynced events, ordered by createdAt
    const allEvents = await store.getAll();
    const unsynced = allEvents
      .filter((e) => !e.synced && e.retryable)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return unsynced.slice(0, limit);
  }

  /**
   * Returns true if any unsynced, retryable outbox event exists.
   * Used to gate pull phase in sync worker.
   */
  async hasAnyRetryableUnsynced(): Promise<boolean> {
    const tx = this.client._db.transaction("OutboxEvent", "readonly");
    const store = tx.objectStore("OutboxEvent");
    let cursor = await store.openCursor();
    while (cursor) {
      const e = cursor.value;
      if (!e.synced && e.retryable) return true;
      cursor = await cursor.continue();
    }
    return false;
  }

  async markSynced(
    appliedLogs: { id: string; lastAppliedChangeId: string | null }[],
    options?: { tx?: IDBUtils.ReadwriteTransactionType; silent?: boolean }
  ): Promise<void> {
    const syncedAt = new Date();
    const tx = options?.tx ?? this.client._db.transaction(["OutboxEvent", "VersionMeta"], "readwrite");
    const store = tx.objectStore("OutboxEvent");

    for (const log of appliedLogs) {
      const event = await store.get([log.id]);
      if (event) {
        const updatedEvent = {
          ...event,
          synced: true,
          syncedAt,
          lastAttemptedAt: syncedAt,
        };
        await store.put(updatedEvent);
        this.emit("update", [event.id], undefined, updatedEvent, {
          silent: options?.silent ?? false,
          addToOutbox: false,
          tx,
        });

        if (!(event.entityType in modelRecordToKeyPath)) {
          throw new Error(`Unknown model: ${event.entityType}`);
        }

        try {
          const parsedKey = modelRecordToKeyPath[event.entityType as keyof typeof modelRecordToKeyPath](event.payload);

          await this.client.$versionMeta.markPushed(event.entityType, parsedKey, { tx });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Failed to parse keyPath for model ${event.entityType}: ${errorMessage}`);
          throw error;
        }
      }
    }

    if (!options?.tx) await tx.done;
  }

  async markFailed(
    eventId: string,
    error: NonNullable<PushResult["error"]>,
    options?: { tx?: IDBUtils.ReadwriteTransactionType; silent?: boolean }
  ): Promise<void> {
    const tx = options?.tx ?? this.client._db.transaction(["OutboxEvent"], "readwrite");
    const store = tx.objectStore("OutboxEvent");

    const event = await store.get([eventId]);
    if (event) {
      const updatedEvent = {
        ...event,
        tries: (event.tries ?? 0) + 1,
        lastError: `${error.type ?? "Error"}: ${error.message}`,
        lastAttemptedAt: new Date(),
        retryable: error.retryable,
      };
      await store.put(updatedEvent);
      this.emit("update", [event.id], undefined, updatedEvent, {
        silent: options?.silent ?? false,
        addToOutbox: false,
        tx,
      });
    }

    if (!options?.tx) await tx.done;
  }

  async stats(): Promise<{ unsynced: number; failed: number; lastError?: string }> {
    const tx = this.client._db.transaction(["OutboxEvent"], "readonly");
    const store = tx.objectStore("OutboxEvent");
    const allEvents = await store.getAll();

    const unsynced = allEvents.filter((e) => !e.synced).length;
    const failed = allEvents.filter((e) => e.lastError !== null && e.lastError !== undefined).length;
    const lastError = allEvents
      .filter((e) => e.lastError)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.lastError;

    return { unsynced, failed, lastError: lastError ?? undefined };
  }

  async clearSynced(options?: {
    olderThanDays?: number;
    tx?: IDBUtils.ReadwriteTransactionType;
    silent?: boolean;
  }): Promise<number> {
    const olderThanDays = options?.olderThanDays ?? 7;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const tx = options?.tx ?? this.client._db.transaction(["OutboxEvent"], "readwrite");
    const store = tx.objectStore("OutboxEvent");
    const allEvents = await store.getAll();

    let deletedCount = 0;
    for (const event of allEvents) {
      if (event.synced && new Date(event.createdAt) < cutoffDate) {
        await store.delete([event.id]);
        this.emit("delete", [event.id], undefined, event, { silent: options?.silent ?? false, addToOutbox: false, tx });
        deletedCount++;
      }
    }

    if (!options?.tx) await tx.done;
    return deletedCount;
  }
}
class VersionMetaIDBClass extends BaseIDBModelClass<"VersionMeta"> {
  constructor(client: PrismaIDBClient, keyPath: string[]) {
    super(client, keyPath, "VersionMeta");
  }

  async get(model: string, key: IDBValidKey, tx?: IDBUtils.TransactionType): Promise<ChangeMetaRecord | undefined> {
    tx = tx ?? this.client._db.transaction(["VersionMeta"], "readonly");
    const store = tx.objectStore("VersionMeta");

    const result = await store.get([model, key]);

    return result as ChangeMetaRecord | undefined;
  }

  async put(meta: ChangeMetaRecord, options?: { tx?: IDBUtils.ReadwriteTransactionType }): Promise<void> {
    const { tx: txOption } = options ?? {};
    const tx = txOption ?? this.client._db.transaction(["VersionMeta"], "readwrite");
    const store = tx.objectStore("VersionMeta");

    const existingMeta = await store.get([meta.model, meta.key]);

    const record: ChangeMetaRecord = {
      model: meta.model,
      key: meta.key,
      lastAppliedChangeId: meta.lastAppliedChangeId ?? existingMeta?.lastAppliedChangeId ?? null,
      localChangePending: meta.localChangePending ?? existingMeta?.localChangePending ?? false,
    };

    await store.put(record);
    if (!txOption) await tx.done;
  }

  async markLocalPending(
    model: string,
    key: IDBValidKey,
    options?: { tx?: IDBUtils.ReadwriteTransactionType }
  ): Promise<void> {
    const { tx: txOption } = options ?? {};
    const tx = txOption ?? this.client._db.transaction(["VersionMeta"], "readwrite");
    const store = tx.objectStore("VersionMeta");

    const existingMeta = await store.get([model, key]);

    const record: ChangeMetaRecord = {
      model,
      key,
      lastAppliedChangeId: existingMeta?.lastAppliedChangeId ?? null,
      localChangePending: true,
    };

    await store.put(record);
    if (!txOption) await tx.done;
  }

  async markPushed(
    model: string,
    key: IDBValidKey,
    options?: { tx?: IDBUtils.ReadwriteTransactionType }
  ): Promise<void> {
    const { tx: txOption } = options ?? {};
    const tx = txOption ?? this.client._db.transaction(["VersionMeta"], "readwrite");
    const store = tx.objectStore("VersionMeta");

    const existingMeta = await store.get([model, key]);
    if (!existingMeta) throw new Error("No existing VersionMeta found for the given model and key");

    const record: ChangeMetaRecord = {
      model,
      key,
      lastAppliedChangeId: existingMeta.lastAppliedChangeId,
      localChangePending: false,
    };

    await store.put(record);
    if (!txOption) await tx.done;
  }

  async markPulled(
    model: string,
    key: IDBValidKey,
    lastAppliedChangelogId: string,
    options?: { tx?: IDBUtils.ReadwriteTransactionType }
  ): Promise<void> {
    const { tx: txOption } = options ?? {};
    const tx = txOption ?? this.client._db.transaction(["VersionMeta"], "readwrite");
    const store = tx.objectStore("VersionMeta");

    const record: ChangeMetaRecord = {
      model,
      key,
      lastAppliedChangeId: lastAppliedChangelogId,
      localChangePending: false,
    };

    await store.put(record);
    if (!txOption) await tx.done;
  }

  async delete(model: string, key: IDBValidKey): Promise<void> {
    const tx = this.client._db.transaction("VersionMeta", "readwrite");
    const store = tx.objectStore("VersionMeta");

    await store.delete([model, key]);
    await tx.done;
  }

  async clearAll(): Promise<number> {
    const tx = this.client._db.transaction("VersionMeta", "readwrite");
    const store = tx.objectStore("VersionMeta");

    const allRecords = await store.getAll();
    const count = allRecords.length;

    await store.clear();
    await tx.done;

    return count;
  }
}
