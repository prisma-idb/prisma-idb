/**
 * SyncWorker — push/pull loop with backoff and EventTarget-style events.
 */

import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { SyncIdbClient } from "./sync-client";
import type { OutboxEvent } from "./outbox-store";
import { getNextBatch, markSynced, markFailed, OUTBOX_STORE } from "./outbox-store";
import { applyPull } from "./apply-pull";
import { createEmitter } from "./emitter";
import { createPullCursor } from "./pull-cursor";
import { VERSION_META_STORE } from "./version-meta";
import type { LogWithRecord, PushResult } from "../types";

// ── Public types ──────────────────────────────────────────────────────────────

export type SyncWorkerStatus = "idle" | "pushing" | "pulling" | "error" | "stopped";

export interface SyncWorkerOptions<TContract extends IdbContract> {
  readonly syncClient: SyncIdbClient<TContract>;
  /** Called with a batch of unsynced events. Must return per-event results. */
  readonly pushHandler: (events: OutboxEvent[], signal: AbortSignal) => Promise<PushResult[]>;
  /** Called with the last applied changelog ID (null if none). Returns new logs. See `getCursor`/`setCursor` to persist the ID across reloads. */
  readonly pullHandler: (fromChangelogId: string | null, signal: AbortSignal) => Promise<LogWithRecord[]>;
  /**
   * Loads the persisted pull cursor. Called once, before the worker's first
   * pull, so a reload resumes from where the last session stopped instead of
   * re-pulling from the start (`null`/`undefined` = no cursor stored yet).
   * Without it the cursor lives in memory only.
   */
  readonly getCursor?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Persists the pull cursor after a pull advances it. If it throws, the cycle
   * fails (status `"error"`, normal backoff) and the write is retried on the
   * next cycle — the applied logs themselves are safe either way, since a
   * re-pull from an older cursor is skipped by `applyPull`'s staleness guard.
   */
  readonly setCursor?: (changelogId: string) => void | Promise<void>;
  /** Max events per push batch. Default 20. */
  readonly batchSize?: number;
  /** Milliseconds between sync cycles when idle. Default 5000. */
  readonly intervalMs?: number;
  /** Base backoff in ms on consecutive failures. Default 1000. */
  readonly backoffBaseMs?: number;
  /** Max backoff cap in ms. Default 30000. */
  readonly backoffMaxMs?: number;
  /**
   * Max time in ms to wait for `pushHandler`/`pullHandler` to settle before
   * failing the cycle. Without this, a hung request never resolves, no
   * timer is rescheduled, and the worker stalls in "pushing"/"pulling"
   * indefinitely. Default 30000.
   */
  readonly requestTimeoutMs?: number;
}

/**
 * Rejects with a timeout error if `makePromise` doesn't settle within `ms`.
 * `makePromise` receives an `AbortSignal` that is aborted on timeout, so the
 * underlying request (e.g. a `fetch` call) can be cancelled instead of left
 * running after we've already given up on it.
 */
function withTimeout<T>(makePromise: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`SyncWorker: ${label} timed out after ${ms}ms`));
    }, ms);
    makePromise(controller.signal).then(
      (value) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timeoutHandle);
        reject(err);
      }
    );
  });
}

export interface PushCompletedEvent {
  synced: number;
  failed: number;
}
export interface PullCompletedEvent {
  applied: number;
  skipped: number;
  validationFailed: number;
}

type SyncEventMap = {
  statuschange: SyncWorkerStatus;
  pushcompleted: PushCompletedEvent;
  pullcompleted: PullCompletedEvent;
};

export interface SyncWorker {
  /** Begin the push/pull loop. No-op if already running. */
  start(): void;
  /** Stop the loop. In-flight cycle completes; no new cycles start. */
  stop(): void;
  /** Trigger one push/pull cycle immediately, ignoring backoff. */
  forceSync(): Promise<void>;
  /** Register an event listener. Returns an unsubscribe function. */
  on<K extends keyof SyncEventMap>(event: K, cb: (payload: SyncEventMap[K]) => void): () => void;
  /** Current worker status. */
  readonly status: SyncWorkerStatus;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createSyncWorker<TContract extends IdbContract>(options: SyncWorkerOptions<TContract>): SyncWorker {
  const {
    syncClient,
    pushHandler,
    pullHandler,
    batchSize = 20,
    intervalMs = 5_000,
    backoffBaseMs = 1_000,
    backoffMaxMs = 30_000,
    requestTimeoutMs = 30_000,
  } = options;

  let status: SyncWorkerStatus = "idle";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  const cursor = createPullCursor(options);
  // Shared across tick() and forceSync() so at most one push/pull cycle runs
  // at a time — otherwise both can call getNextBatch concurrently and push
  // the same unsynced events twice.
  let inFlightCycle: Promise<void> | null = null;

  const { emit, on } = createEmitter<SyncEventMap>();

  function setStatus(next: SyncWorkerStatus): void {
    if (status === next) return;
    status = next;
    emit("statuschange", next);
  }

  async function pushPending(): Promise<void> {
    setStatus("pushing");
    const events = await getNextBatch(syncClient.rawClient, { limit: batchSize });
    if (events.length === 0) return;

    let pushSynced = 0;
    let pushFailed = 0;
    const results = await withTimeout((signal) => pushHandler(events, signal), requestTimeoutMs, "pushHandler");
    await syncClient.withTransaction([OUTBOX_STORE, VERSION_META_STORE], async (scope) => {
      for (const result of results) {
        if (result.success) {
          await markSynced(scope, result.id);
          pushSynced++;
        } else {
          await markFailed(scope, result.id, result.error ?? "unknown error", result.retryable);
          pushFailed++;
        }
      }
    });
    emit("pushcompleted", { synced: pushSynced, failed: pushFailed });
  }

  async function pullChanges(): Promise<void> {
    setStatus("pulling");
    await cursor.load();
    const logs = await withTimeout((signal) => pullHandler(cursor.value, signal), requestTimeoutMs, "pullHandler");
    const { applied, skipped, validationFailed, lastChangelogId } = await applyPull(syncClient, logs);
    cursor.advance(lastChangelogId);
    emit("pullcompleted", { applied, skipped, validationFailed });
    await cursor.save();
  }

  async function runCycle(): Promise<void> {
    await pushPending();
    await pullChanges();
  }

  /** Runs `runCycle`, joining an already-in-flight cycle instead of starting a second one. */
  function runExclusive(): Promise<void> {
    if (inFlightCycle !== null) return inFlightCycle;
    inFlightCycle = runCycle().finally(() => {
      inFlightCycle = null;
    });
    return inFlightCycle;
  }

  /** Sets `timer`, clearing it to `null` right before `tick` runs so tick's own reschedule guard works. */
  function scheduleTick(delay: number): void {
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await runExclusive();
      // stop() may have run while runExclusive() was in flight; don't
      // clobber the "stopped" status it already set.
      if (stopped) return;
      consecutiveFailures = 0;
      setStatus("idle");
    } catch {
      if (stopped) return;
      consecutiveFailures++;
      setStatus("error");
    }
    // Guarded by `timer === null` because forceSync() may have already
    // rescheduled while this cycle was in flight (shared via runExclusive) —
    // without the guard both continuations would set `timer`, leaking the
    // first one uncleared.
    if (!stopped && timer === null) {
      const backoff = Math.min(
        consecutiveFailures > 0 ? backoffBaseMs * Math.pow(2, consecutiveFailures - 1) : intervalMs,
        backoffMaxMs
      );
      scheduleTick(backoff);
    }
  }

  return {
    get status() {
      return status;
    },
    start() {
      if (timer !== null) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setStatus("stopped");
    },
    async forceSync() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await runExclusive();
        // stop() may have run while runExclusive() was in flight; don't
        // clobber the "stopped" status it already set.
        if (!stopped) {
          consecutiveFailures = 0;
          setStatus("idle");
        }
      } finally {
        if (!stopped && timer === null) {
          scheduleTick(intervalMs);
        }
      }
    },
    on,
  };
}
