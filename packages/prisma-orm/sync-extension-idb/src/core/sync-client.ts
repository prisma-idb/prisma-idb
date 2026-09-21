/**
 * Sync-aware IDB client.
 *
 * `createSyncIdbClient` assembles the same runtime stack as `createIdbClient`
 * but injects `SyncInterceptorExecutor` between the ORM layer and the
 * runtime. Every tracked mutation atomically appends an outbox event (and
 * a version-meta update when the primary key is statically knowable) in the
 * same IDB transaction as the model write.
 */

import { IdbAdapter } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import { createIdbRuntime } from "@prisma-idb/runtime-idb/runtime";
import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { idbOrm } from "@prisma-idb/client-idb/orm";
import type { IdbOrmClient, IdbContract } from "@prisma-idb/client-idb/orm";
import type { IdbClient } from "@prisma-idb/client-idb/client";
import { SyncInterceptorExecutor } from "./sync-executor";
import type { SyncWorkerOptions } from "./sync-worker";
import { createSyncWorker } from "./sync-worker";
import type { OutboxWriteEntry } from "../types";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Events `SyncIdbClient.on(...)` can subscribe to. Just one today —
 * `"outboxwrite"` — but keyed the same way as `SyncWorker`'s `SyncEventMap`
 * (see sync-worker.ts) so both use one subscription shape instead of two.
 */
export type SyncClientEventMap = {
  outboxwrite: readonly OutboxWriteEntry[];
};

export interface SyncIdbClientOptions<TContract extends IdbContract> {
  /** The resolved IDB contract. */
  readonly contract: TContract;
  /** IDB database name — must match the already-migrated DB. */
  readonly dbName: string;
  /** IDB factory override — primarily for tests. Defaults to `indexedDB`. */
  readonly factory?: IDBFactory;
  /**
   * Models to write outbox events for.
   *
   * Pass an array of model names to scope tracking to specific models.
   * Defaults to `'*'` (all models).
   */
  readonly trackedModels?: ReadonlyArray<string> | "*";
}

export interface SyncIdbClient<TContract extends IdbContract> {
  /** The resolved IDB contract this client was created with. */
  readonly contract: TContract;

  /**
   * Sync-aware ORM client.
   *
   * Same API as `IdbClient.orm`, but every tracked mutation atomically writes
   * an outbox event (and updates VersionMeta) alongside the model write.
   */
  readonly orm: IdbOrmClient<TContract>;

  /**
   * Run a callback with the raw ORM, bypassing outbox tracking.
   *
   * Use for local-only writes: drafts, temporary records, or data applied from
   * the server via `applyPull`. The raw ORM issues exactly the same IDB writes
   * the sync ORM does, minus the outbox + version-meta side-effects.
   */
  withoutTracking<T>(fn: (rawOrm: IdbOrmClient<TContract>) => Promise<T>): Promise<T>;

  /**
   * Open a raw multi-store IDB transaction spanning the given stores.
   * Useful for low-level atomic writes (e.g. `applyPull` internals).
   */
  withTransaction<T>(storeNames: string[], fn: (scope: IdbTransactionScope) => Promise<T>): Promise<T>;

  /** Create a `SyncWorker` bound to this client. */
  createSyncWorker(
    options: Omit<SyncWorkerOptions<TContract>, "syncClient">
  ): ReturnType<typeof createSyncWorker<TContract>>;

  /**
   * Subscribe to sync-client events. Just `"outboxwrite"` today — fired once
   * per tracked IDB write call, after its outbox event(s) have committed,
   * with the `OutboxWriteEntry[]` that call wrote (model, operation, key,
   * payload — see that type's doc comment for exactly what "once per call"
   * covers for batched writes like `createAll()` or a cascade delete).
   * Prefer this over re-deriving "did anything change" after every
   * individual `db.orm.*` call site — subscribe once, e.g. to recompute a
   * pending-count badge, or to react to specific models/operations directly
   * from the entries instead of a full outbox rescan. Returns an unsubscribe
   * function.
   */
  on<K extends keyof SyncClientEventMap>(event: K, callback: (payload: SyncClientEventMap[K]) => void): () => void;

  /** Verify the contract marker matches this database. Delegates to `rawClient`. */
  verifyMarker(): Promise<boolean>;

  /** Close the underlying IDB connection. Delegates to `rawClient`. */
  close(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;

  /**
   * The underlying raw `IdbClient` — for the raw (untracked) ORM. Prefer
   * `verifyMarker()`/`close()` directly on this client over
   * `rawClient.verifyMarker()`/`rawClient.close()`; they're the same calls.
   */
  readonly rawClient: IdbClient<TContract>;
}

// ── withTransaction helper ────────────────────────────────────────────────────

async function runInTransaction<T>(
  runtime: { transaction: (stores: string[], mode?: IDBTransactionMode) => Promise<IdbTransactionScope> },
  storeNames: string[],
  fn: (scope: IdbTransactionScope) => Promise<T>
): Promise<T> {
  const scope = await runtime.transaction(storeNames);
  try {
    const result = await fn(scope);
    await scope.commit();
    return result;
  } catch (err) {
    scope.rollback();
    throw err;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a sync-aware IDB client.
 *
 * Builds the same runtime stack as `createIdbClient` but injects the sync
 * executor wrapper so every tracked ORM mutation atomically writes an outbox
 * event in the same IDB transaction.
 *
 * The DB must already be migrated — call `createAutoMigratingIdbClient` with
 * `extensions: [idbSyncExtension]` before calling this.
 *
 * @example
 * ```ts
 * import { idbSyncExtension } from '@prisma-idb/sync-extension-idb/control';
 *
 * await createAutoMigratingIdbClient({ contractSpace, dbName, extensions: [idbSyncExtension] });
 * const db = createSyncIdbClient({ contract: contractSpace.contractJson, dbName });
 *
 * await db.orm.users.create({ id: crypto.randomUUID(), name: 'Alice' });
 * // ↑ atomically: writes `users` record + outbox event in one IDB tx
 * ```
 */
export function createSyncIdbClient<TContract extends IdbContract>(
  options: SyncIdbClientOptions<TContract>
): SyncIdbClient<TContract> {
  const trackedModels = options.trackedModels ?? "*";

  // Same shape as SyncWorker's own listener map (sync-worker.ts) — one event
  // today, but keyed so adding another later doesn't need a new Set/method pair.
  const listeners = new Map<keyof SyncClientEventMap, Set<(payload: unknown) => void>>();
  function emit<K extends keyof SyncClientEventMap>(event: K, payload: SyncClientEventMap[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) cb(payload);
  }
  function on<K extends keyof SyncClientEventMap>(
    event: K,
    callback: (payload: SyncClientEventMap[K]) => void
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const wrapped = callback as (payload: unknown) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  const driver = createIDBRuntimeDriver(
    options.dbName,
    undefined,
    options.factory !== undefined ? { factory: options.factory } : undefined
  ).create();
  const adapter = new IdbAdapter(idbCodecLookup);
  const runtime = createIdbRuntime({
    adapter,
    driver,
    contract: options.contract as Record<string, unknown>,
  });

  const syncExecutor = new SyncInterceptorExecutor(runtime, {
    contract: options.contract,
    trackedModels,
    onOutboxWrite: (entries) => emit("outboxwrite", entries),
  });

  const syncOrm = idbOrm({ contract: options.contract, executor: syncExecutor });
  const rawOrm = idbOrm({ contract: options.contract, executor: runtime });

  const withTransaction = <T>(storeNames: string[], fn: (scope: IdbTransactionScope) => Promise<T>) =>
    runInTransaction(runtime, storeNames, fn);

  const rawClient: IdbClient<TContract> = {
    orm: rawOrm,
    withTransaction,
    verifyMarker: () => runtime.verifyMarker(),
    async close() {
      await runtime.close();
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };

  const client: SyncIdbClient<TContract> = {
    contract: options.contract,
    orm: syncOrm,
    withoutTracking: <T>(fn: (rawOrm: IdbOrmClient<TContract>) => Promise<T>) => fn(rawOrm),
    withTransaction,
    createSyncWorker: (opts) => createSyncWorker({ ...opts, syncClient: client }),
    on,
    verifyMarker: () => rawClient.verifyMarker(),
    close: () => rawClient.close(),
    [Symbol.asyncDispose]: () => rawClient.close(),
    rawClient,
  };

  return client;
}
