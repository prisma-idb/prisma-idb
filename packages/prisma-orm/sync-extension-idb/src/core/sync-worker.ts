/**
 * SyncWorker — push/pull loop with backoff and EventTarget-style events.
 */

import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { SyncIdbClient } from "./sync-client";
import type { OutboxEvent } from "./outbox-store";
import {
  getNextBatch,
  getOldestPendingEvent,
  readForPush,
  markSynced,
  markFailed,
  pruneSyncedEvents,
  OUTBOX_STORE,
} from "./outbox-store";
import { applyPull } from "./apply-pull";
import { applyReconciliation, planReconciliation } from "./reconcile-rejected";
import type { Reconciliation } from "./reconcile-rejected";
import { ContractMismatchError } from "./contract-mismatch-error";
import { createEmitter } from "./emitter";
import { createPullCursor } from "./pull-cursor";
import { VERSION_META_STORE } from "./version-meta";
import type { LogWithRecord, PullChange, PushResult } from "../types";

// ── Public types ──────────────────────────────────────────────────────────────

/** The worker’s observable cycle or lifecycle state. */
export type SyncWorkerStatus = "idle" | "pushing" | "pulling" | "error" | "stopped";

/** What the worker passes to a handler besides its data: the facts the server needs to vet the request. */
export interface SyncRequestContext {
  /**
   * The emitted client contract's storage hash. Send it with each request
   * and forward it as `clientStorageHash` to the server's `pull`/`applyPush`.
   */
  readonly storageHash: string;
}

/** Configures transport handlers, batching, and retry timing. */
export interface SyncWorkerOptions<TContract extends IdbContract> {
  readonly syncClient: SyncIdbClient<TContract>;
  /**
   * Called with a batch of unsynced events. Must return per-event results.
   * Throw `ContractMismatchError` if the server answers 409.
   */
  readonly pushHandler: (
    events: OutboxEvent[],
    signal: AbortSignal,
    context: SyncRequestContext
  ) => Promise<PushResult[]>;
  /**
   * Called with the last applied changelog ID (null if none). Returns new logs. The ID is persisted in IndexedDB across reloads.
   * Throw `ContractMismatchError` if the server answers 409.
   */
  readonly pullHandler: (
    fromChangelogId: string | null,
    signal: AbortSignal,
    context: SyncRequestContext
  ) => Promise<LogWithRecord[]>;
  /** Sync on browser online and visible-page events while started. Default false. */
  readonly syncOnReconnect?: boolean;
  /** Max events per push batch. Default 20. */
  readonly batchSize?: number;
  /** Milliseconds between sync cycles when idle. Default 5000. */
  readonly intervalMs?: number;
  /**
   * Base backoff in ms, doubled per consecutive failure. Applies to failed
   * cycles and to each outbox event's failed pushes. Default 1000.
   */
  readonly backoffBaseMs?: number;
  /** Max backoff cap in ms, for both. Default 30000. */
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

/** Preserves Error details and safely wraps other thrown values for subscribers. */
function toSyncError(value: unknown): Error {
  if (value instanceof Error) return value;
  let message = "Sync cycle failed";
  try {
    message = String(value);
  } catch {
    // Some thrown values cannot be converted to a string; preserve them as the cause.
  }
  return new Error(message, { cause: value });
}

/** Failed tries after which the oldest pending event is reported as stalled. */
const STALLED_AFTER_TRIES = 10;

/** Summarizes a push attempt and pending work that prevents pulling. */
export interface PushCompletedEvent {
  synced: number;
  failed: number;
  /**
   * Events the server rejected for good whose local write could not be
   * replaced by the server's row, because the push result carried no usable
   * `record`. The local write stays until a pull overwrites it.
   */
  unreconciled: number;
  /**
   * True if retryable events remain in the outbox. The worker then skips this
   * cycle's pull, so server state never lands over an edit the server has not seen.
   */
  pullBlocked: boolean;
  /**
   * Set when the oldest pending event has failed `STALLED_AFTER_TRIES` times
   * or more. Events are pushed in order, so everything behind it waits too.
   */
  stalled?: { eventId: string; tries: number; lastError: string | null };
}
/** Summarizes records consumed from a pull page and whether application halted. */
export interface PullCompletedEvent {
  applied: number;
  /** Committed changelog entries from this pull page, in order. */
  changes: PullChange[];
  skipped: number;
  validationFailed: number;
  /** True if the page stopped early at a row that could not be applied yet; the next pull restarts there. */
  halted: boolean;
}

/** Identifies the request refused because client and server contracts differ. */
export interface ContractMismatchEvent {
  /** The request the server refused. */
  during: "push" | "pull";
}

/** Payload types for lifecycle, failure, push, pull, and contract-mismatch notifications. */
type SyncEventMap = {
  statuschange: SyncWorkerStatus;
  /** A failed cycle other than a contract mismatch, emitted after status becomes "error". */
  error: Error;
  pushcompleted: PushCompletedEvent;
  pullcompleted: PullCompletedEvent;
  /** The server refused a request because this client's contract is out of step with its own. The pull cursor, queued edits and their payloads are preserved. */
  contractmismatch: ContractMismatchEvent;
};

/** Controls one serialized push and pull loop and exposes its notifications. */
export interface SyncWorker {
  /** Begin the push/pull loop. No-op if already running. */
  start(): void;
  /** Stop notifications and new cycles, then wait for the active cycle to settle, including on failure. */
  stop(): Promise<void>;
  /** Trigger one push/pull cycle immediately, ignoring backoff. */
  forceSync(): Promise<void>;
  /** Register an event listener. Returns an unsubscribe function. */
  on<K extends keyof SyncEventMap>(event: K, cb: (payload: SyncEventMap[K]) => void): () => void;
  /** Current worker status. */
  readonly status: SyncWorkerStatus;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Creates a serialized push and pull worker with per-event and per-cycle backoff. */
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
    syncOnReconnect = false,
  } = options;
  const backoff = { baseMs: backoffBaseMs, maxMs: backoffMaxMs };

  let status: SyncWorkerStatus = "idle";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  const cursor = createPullCursor(syncClient);
  // Shared across tick() and forceSync() so at most one push/pull cycle runs
  // at a time — otherwise both can call getNextBatch concurrently and push
  // the same unsynced events twice.
  let inFlightCycle: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  const emitter = createEmitter<SyncEventMap>();

  /** A stopped worker may announce its stopped status, but no later cycle effects. */
  function emit<K extends keyof SyncEventMap>(event: K, payload: SyncEventMap[K]): void {
    if (!stopped || (event === "statuschange" && payload === "stopped")) emitter.emit(event, payload);
  }

  /** Publishes a status change only when the observable state changes. */
  function setStatus(next: SyncWorkerStatus): void {
    if (status === next || (stopped && next !== "stopped")) return;
    status = next;
    emit("statuschange", next);
  }

  const requestContext: SyncRequestContext = {
    storageHash: syncClient.contract.storage.storageHash,
  };

  /** Emits the contract-mismatch notification for a refused transport request. */
  function reportContractMismatch(error: unknown, during: ContractMismatchEvent["during"]): void {
    if (error instanceof ContractMismatchError) emit("contractmismatch", { during });
  }

  /**
   * Pushes batches until the outbox has nothing left to send now: it is empty,
   * or its oldest event is waiting out a retry backoff. Returns whether a
   * retryable event remains, in which case the cycle must not pull.
   */
  async function pushPending(): Promise<boolean> {
    setStatus("pushing");
    const totals = { synced: 0, failed: 0, unreconciled: 0 };
    let sentAny = false;
    let pullBlocked = false;
    try {
      while (!stopped) {
        const events = await getNextBatch(syncClient.rawClient, { limit: batchSize, backoff });
        if (stopped || events.length === 0) break;
        sentAny = true;
        const results = await sendBatch(events);
        const counts = await recordPushResults(events, results);
        totals.synced += counts.synced;
        totals.failed += counts.failed;
        totals.unreconciled += counts.unreconciled;
        // Stop at a retryable failure rather than resend its event at once, whatever the backoff.
        // A handler that answers for none of the events would otherwise resend the same batch forever.
        if (counts.retryableFailure || counts.matched === 0) break;
      }
    } finally {
      // Also runs when a request throws, so a failing transport still reports `stalled`.
      pullBlocked = await reportPush(totals, sentAny);
    }
    return pullBlocked;
  }

  /**
   * Sends one batch. If the request throws or times out, records a retryable
   * failed attempt on every event, so `tries` and backoff advance as they do
   * for a server-reported failure, then rethrows for the cycle's own backoff.
   */
  async function sendBatch(events: OutboxEvent[]): Promise<PushResult[]> {
    try {
      return await withTimeout(
        (signal) =>
          pushHandler(
            events.map((event) => readForPush(syncClient.contract, event)),
            signal,
            requestContext
          ),
        requestTimeoutMs,
        "pushHandler"
      );
    } catch (error) {
      reportContractMismatch(error, "push");
      const message = toSyncError(error).message;
      await syncClient.withTransaction([OUTBOX_STORE, VERSION_META_STORE], async (scope) => {
        for (const { id } of events) await markFailed(scope, id, message);
      });
      throw error;
    }
  }

  /** Emits `pushcompleted` if a push was attempted or is still owed. Returns whether pull must wait. */
  async function reportPush(totals: { synced: number; failed: number; unreconciled: number }, sentAny: boolean) {
    const oldest = await getOldestPendingEvent(syncClient.rawClient);
    const stalled =
      oldest !== null && oldest.tries >= STALLED_AFTER_TRIES
        ? { eventId: oldest.id, tries: oldest.tries, lastError: oldest.lastError }
        : undefined;
    if (sentAny || oldest !== null)
      emit("pushcompleted", { ...totals, pullBlocked: oldest !== null, ...(stalled && { stalled }) });
    return oldest !== null;
  }

  /**
   * Records one batch's results in a single transaction. A result the server
   * rejected for good also replaces the local row with the server's, in the
   * same transaction as the failure, so the pending flag never clears while
   * the rejected write is still there.
   */
  async function recordPushResults(events: OutboxEvent[], results: PushResult[]) {
    const eventsById = new Map(events.map((event) => [event.id, event]));
    // In the order the events were sent, whatever order the server answered in: a
    // rejected event's reconcile relies on the later events of its row being handled after it.
    const sentOrder = new Map(events.map((event, index) => [event.id, index]));
    const matched = results
      .filter(({ id }) => eventsById.has(id))
      .sort((a, b) => sentOrder.get(a.id)! - sentOrder.get(b.id)!);
    const reconciliations = new Map<string, Reconciliation>();
    let unreconciled = 0;
    for (const result of matched) {
      const event = eventsById.get(result.id);
      if (!event || result.success || result.retryable !== false) continue;
      const reconciliation = planReconciliation(syncClient.contract, event, result);
      if (reconciliation) reconciliations.set(result.id, reconciliation);
      else unreconciled++;
    }

    const modelStores = [...new Set([...reconciliations.values()].map(({ storeName }) => storeName))];
    let synced = 0;
    let failed = 0;
    await syncClient.withTransaction([OUTBOX_STORE, VERSION_META_STORE, ...modelStores], async (scope) => {
      for (const result of matched) {
        if (result.success) {
          await markSynced(scope, result.id);
          synced++;
        } else {
          await markFailed(scope, result.id, result.error ?? "unknown error", result.retryable);
          const reconciliation = reconciliations.get(result.id);
          if (reconciliation) await applyReconciliation(scope, reconciliation);
          failed++;
        }
      }
      await pruneSyncedEvents(scope);
    });
    const retryableFailure = matched.some((result) => !result.success && result.retryable !== false);
    return { synced, failed, unreconciled, matched: matched.length, retryableFailure };
  }

  /** Applies the next pull page and saves only the cursor position it consumed safely. */
  async function pullChanges(): Promise<void> {
    setStatus("pulling");
    await cursor.load();
    if (stopped) return;
    let logs: LogWithRecord[];
    try {
      logs = await withTimeout(
        (signal) => pullHandler(cursor.value, signal, requestContext),
        requestTimeoutMs,
        "pullHandler"
      );
    } catch (error) {
      reportContractMismatch(error, "pull");
      throw error;
    }
    const { applied, changes, skipped, validationFailed, halted, lastChangelogId } = await applyPull(syncClient, logs);
    cursor.advance(lastChangelogId);
    emit("pullcompleted", { applied, changes, skipped, validationFailed, halted });
    await cursor.save();
  }

  /** Push first, then pull only if nothing is left to push. The two never overlap, so a pull never lands on an unsent local edit. */
  async function runCycle(): Promise<void> {
    try {
      await syncClient.withTransaction([OUTBOX_STORE], pruneSyncedEvents);
    } catch {
      // History cleanup is best-effort; a failure must not block pending pushes.
    }
    if (stopped) return;
    const pullBlocked = await pushPending();
    if (!stopped && !pullBlocked) await pullChanges();
  }

  /** Runs `runCycle`, joining an already-in-flight cycle instead of starting a second one. */
  function runExclusive(): Promise<void> {
    if (inFlightCycle !== null) return inFlightCycle;
    inFlightCycle = runCycle()
      .catch((error: unknown) => {
        // Report once per cycle, even when scheduled and forced callers share it.
        if (!stopped) {
          setStatus("error");
          if (!stopped && !(error instanceof ContractMismatchError)) emit("error", toSyncError(error));
        }
        throw error;
      })
      .finally(() => {
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

  /** Runs one scheduled cycle and reschedules according to its failure count. */
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

  let removeReconnectListeners: (() => void) | null = null;

  /** Attaches browser listeners once per started lifecycle, including after restart. */
  function listenForReconnect(): void {
    if (!syncOnReconnect || removeReconnectListeners !== null) return;
    const browserWindow = typeof window === "undefined" ? undefined : window;
    const browserDocument = typeof document === "undefined" ? undefined : document;
    /** Shares overlapping event requests through the worker's exclusive cycle. */
    function reconnect(): void {
      // runExclusive reports failures through the error event; event handlers have no caller to reject to.
      void worker.forceSync().catch(() => {});
    }
    /** A hidden-page event must not initiate network work. */
    function visibilityChanged(): void {
      if (browserDocument?.visibilityState === "visible") reconnect();
    }
    browserWindow?.addEventListener("online", reconnect);
    browserDocument?.addEventListener("visibilitychange", visibilityChanged);
    removeReconnectListeners = () => {
      browserWindow?.removeEventListener("online", reconnect);
      browserDocument?.removeEventListener("visibilitychange", visibilityChanged);
      removeReconnectListeners = null;
    };
  }

  const worker: SyncWorker = {
    get status() {
      return status;
    },
    start() {
      if (timer !== null || stopping !== null) return;
      stopped = false;
      listenForReconnect();
      void tick();
    },
    stop() {
      stopped = true;
      removeReconnectListeners?.();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Install the drain guard before notifying listeners, which can call start().
      stopping ??= (inFlightCycle ?? Promise.resolve())
        .catch(() => {})
        .finally(() => {
          stopping = null;
        });
      setStatus("stopped");
      return stopping;
    },
    async forceSync() {
      if (stopped) return;
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
    on: emitter.on,
  };
  return worker;
}
