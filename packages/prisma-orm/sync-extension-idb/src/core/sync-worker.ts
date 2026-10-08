/**
 * SyncWorker — push/pull loop with backoff and EventTarget-style events.
 */

import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { contractFingerprint } from "@prisma-idb/target-idb/runtime";
import type { SyncIdbClient } from "./sync-client";
import type { OutboxEvent } from "./outbox-store";
import { getNextBatch, getOldestPendingEvent, markSynced, markFailed, OUTBOX_STORE } from "./outbox-store";
import { applyPull } from "./apply-pull";
import { applyReconciliation, planReconciliation } from "./reconcile-rejected";
import type { Reconciliation } from "./reconcile-rejected";
import { ContractMismatchError } from "./contract-mismatch-error";
import { createEmitter } from "./emitter";
import { createPullCursor } from "./pull-cursor";
import { VERSION_META_STORE } from "./version-meta";
import type { LogWithRecord, PushResult } from "../types";

// ── Public types ──────────────────────────────────────────────────────────────

export type SyncWorkerStatus = "idle" | "pushing" | "pulling" | "error" | "stopped";

/** What the worker passes to a handler besides its data: the facts the server needs to vet the request. */
export interface SyncRequestContext {
  /**
   * Resolves to the fingerprint of this client's contract. Send it with the
   * request (for example as a header) and forward it to the server's
   * `pull`/`applyPush`. The server refuses a request whose fingerprint
   * differs from its own. Computed on first call, then reused.
   */
  readonly contractFingerprint: () => Promise<string>;
}

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
   * Called with the last applied changelog ID (null if none). Returns new logs. See `getCursor`/`setCursor` to persist the ID across reloads.
   * Throw `ContractMismatchError` if the server answers 409.
   */
  readonly pullHandler: (
    fromChangelogId: string | null,
    signal: AbortSignal,
    context: SyncRequestContext
  ) => Promise<LogWithRecord[]>;
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
   * re-pull from an older cursor replays rows `applyPull` already applied and
   * counts them as consumed.
   */
  readonly setCursor?: (changelogId: string) => void | Promise<void>;
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

/** Failed tries after which the oldest pending event is reported as stalled. */
const STALLED_AFTER_TRIES = 10;

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
export interface PullCompletedEvent {
  applied: number;
  skipped: number;
  validationFailed: number;
  /** True if the page stopped early at a row that could not be applied yet; the next pull restarts there. */
  halted: boolean;
}

export interface ContractMismatchEvent {
  /** The request the server refused. */
  during: "push" | "pull";
}

type SyncEventMap = {
  statuschange: SyncWorkerStatus;
  pushcompleted: PushCompletedEvent;
  pullcompleted: PullCompletedEvent;
  /** The server refused a request because this client's contract is out of step with its own. The pull cursor, queued edits and their payloads are preserved. */
  contractmismatch: ContractMismatchEvent;
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
  const backoff = { baseMs: backoffBaseMs, maxMs: backoffMaxMs };

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

  let fingerprint: Promise<string> | undefined;
  const requestContext: SyncRequestContext = {
    contractFingerprint: () => (fingerprint ??= contractFingerprint(syncClient.contract)),
  };

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
      for (;;) {
        const events = await getNextBatch(syncClient.rawClient, { limit: batchSize, backoff });
        if (events.length === 0) break;
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
        (signal) => pushHandler(events, signal, requestContext),
        requestTimeoutMs,
        "pushHandler"
      );
    } catch (error) {
      reportContractMismatch(error, "push");
      const message = error instanceof Error ? error.message : String(error);
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
    });
    const retryableFailure = matched.some((result) => !result.success && result.retryable !== false);
    return { synced, failed, unreconciled, matched: matched.length, retryableFailure };
  }

  async function pullChanges(): Promise<void> {
    setStatus("pulling");
    await cursor.load();
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
    const { applied, skipped, validationFailed, halted, lastChangelogId } = await applyPull(syncClient, logs);
    cursor.advance(lastChangelogId);
    emit("pullcompleted", { applied, skipped, validationFailed, halted });
    await cursor.save();
  }

  /** Push first, then pull only if nothing is left to push. The two never overlap, so a pull never lands on an unsent local edit. */
  async function runCycle(): Promise<void> {
    const pullBlocked = await pushPending();
    if (!pullBlocked) await pullChanges();
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
