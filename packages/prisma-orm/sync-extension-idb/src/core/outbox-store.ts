/**
 * Low-level read/write helpers for `_idb_sync_outbox`.
 *
 * These functions operate directly on `IdbTransactionScope` (for writes) or
 * `IdbClient` (for reads that open their own transaction). They do NOT go
 * through the ORM so as not to trigger the sync interceptor.
 */

import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbClient } from "@prisma-idb/client-idb/client";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { OutboxEvent } from "../types";
import { deleteRecord, getRecord, putRecord, scanStore } from "./raw-store";
import { VERSION_META_STORE } from "./version-meta";

export type { OutboxEvent };

/** The object store holding pending and finished outbox events. */
export const OUTBOX_STORE = "_idb_sync_outbox";

/** An event the next push may still send: not yet synced, and the server has not ruled it out. */
const isPending = (event: OutboxEvent) => !event.synced && event.retryable;

// ── Read helpers ──────────────────────────────────────────────────────────────

/** How long a failed event waits before its next attempt: `baseMs`, doubling per failed try, capped at `maxMs`. */
export interface RetryBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
}

/** The wait after an event's `tries`-th failure. */
function retryDelayMs(tries: number, { baseMs, maxMs }: RetryBackoff): number {
  return Math.min(baseMs * Math.pow(2, tries - 1), maxMs);
}

/** True while `event` is still waiting out the backoff after its last failed attempt. */
function isInBackoff(event: OutboxEvent, backoff: RetryBackoff, now: Date): boolean {
  if (event.tries === 0 || !(event.lastAttemptedAt instanceof Date)) return false;
  return now.getTime() < event.lastAttemptedAt.getTime() + retryDelayMs(event.tries, backoff);
}

/**
 * Every unsynced, retryable outbox event, oldest first (`createdAt`
 * ascending → FIFO ordering for push).
 *
 * Filters `synced`/`retryable` in-memory over a full store scan — `boolean`
 * is not a valid IndexedDB key type (still an open spec proposal:
 * https://github.com/w3c/IndexedDB/issues/76), so a `bySynced` index would
 * throw a `DataError` on any range query against it (`IDBKeyRange.only(false)`)
 * and silently omit records on write. The contract no longer declares that
 * index.
 */
async function readPendingEvents(scope: IdbTransactionScope): Promise<OutboxEvent[]> {
  const at = (d: Date | null) => (d instanceof Date ? d.getTime() : 0);
  return (await scanStore<OutboxEvent>(scope, OUTBOX_STORE))
    .filter(isPending)
    .sort((a, b) => at(a.createdAt) - at(b.createdAt));
}

/**
 * Fetch the next batch of events to push: pending events, oldest first.
 *
 * With `backoff`, the batch stops at the first event still waiting out its
 * retry delay. A later event never overtakes an earlier one, because it may
 * depend on it (a Todo created in a Board the earlier event creates), and a
 * failing event cannot fill the batch while the ones behind it starve.
 */
export async function getNextBatch<TContract extends IdbContract>(
  client: IdbClient<TContract>,
  options?: { limit?: number; backoff?: RetryBackoff; now?: Date }
): Promise<OutboxEvent[]> {
  const { limit = 20, backoff, now = new Date() } = options ?? {};
  const batch: OutboxEvent[] = [];

  await client.withTransaction([OUTBOX_STORE], async (scope) => {
    for (const event of await readPendingEvents(scope)) {
      if (batch.length === limit || (backoff && isInBackoff(event, backoff, now))) break;
      batch.push(event);
    }
  });

  return batch;
}

/** The oldest event the next push may still send, or `null` if the outbox has none. */
export async function getOldestPendingEvent<TContract extends IdbContract>(
  client: IdbClient<TContract>
): Promise<OutboxEvent | null> {
  let oldest: OutboxEvent | null = null;
  await client.withTransaction([OUTBOX_STORE], async (scope) => {
    oldest = (await readPendingEvents(scope))[0] ?? null;
  });
  return oldest;
}

// ── Write helpers (inside an existing transaction scope) ──────────────────────

/** Keep the newest 100 acknowledged events; failed and unsent events remain for retry or recovery. */
export async function pruneSyncedEvents(scope: IdbTransactionScope): Promise<void> {
  const acknowledged = (await scanStore<OutboxEvent>(scope, OUTBOX_STORE))
    .filter((event) => event.synced === true)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const event of acknowledged.slice(100)) {
    await deleteRecord(scope, OUTBOX_STORE, event.id);
  }
}

/**
 * True if some OTHER outbox event still references `versionMetaId` and could
 * still succeed (unsynced, retryable) — a full store scan, same as
 * `getNextBatch` (no queryable index; see that function's doc comment). The
 * event whose own write just triggered this check has already had its
 * `synced`/`retryable` field updated by the caller before this runs, so it
 * naturally doesn't match here — no need to also exclude it by id.
 */
async function hasOtherPendingOutboxEvents(scope: IdbTransactionScope, versionMetaId: string): Promise<boolean> {
  const events = await scanStore<OutboxEvent>(scope, OUTBOX_STORE);
  return events.some((e) => e.versionMetaId === versionMetaId && isPending(e));
}

/**
 * Clears `localChangePending` on the version-meta row an outbox event was
 * keyed under, if any — shared by `markSynced` (the event's own write
 * succeeded) and `markFailed` (the event is dead and will never succeed, see
 * that function's doc comment). Reads the id persisted at write time
 * (`versionMetaKey(modelName, key)`) rather than re-deriving it from the
 * payload — the payload shape differs per operation (create/update/delete)
 * and re-deriving it here previously matched only
 * `create` on models keyed by a literal `id` field, so `localChangePending`
 * never cleared for update/delete and `applyPull` skipped all future server
 * changes for that record. Leaves the flag set (rather than clearing it) when
 * another unsynced, retryable event for the same record still exists —
 * clearing it here would let a pull land in between and clobber that
 * still-pending local change.
 */
async function clearLocalChangePending(scope: IdbTransactionScope, versionMetaId: string | null): Promise<void> {
  if (versionMetaId === null) return;
  // Another unsynced, retryable event for the same record still needs this
  // flag set — clearing it now would let a pull land in between and clobber
  // that still-pending local change.
  if (await hasOtherPendingOutboxEvents(scope, versionMetaId)) return;
  const meta = await getRecord(scope, VERSION_META_STORE, versionMetaId);
  if (!meta) return;
  await putRecord(scope, VERSION_META_STORE, { ...meta, localChangePending: false });
}

/** Mark an outbox event as successfully synced. */
export async function markSynced(scope: IdbTransactionScope, id: string): Promise<void> {
  const existing = await getRecord<OutboxEvent>(scope, OUTBOX_STORE, id);
  if (!existing) return;
  await putRecord(scope, OUTBOX_STORE, { ...existing, synced: true, syncedAt: new Date() });
  await clearLocalChangePending(scope, existing.versionMetaId);
}

/**
 * Record a push failure — increment tries and store the error. The event
 * stays retryable, however many tries it has had, unless the server says it
 * never can succeed; `getNextBatch` spaces the attempts out with a backoff.
 *
 * `serverRetryable` is the push result's own `retryable` flag: `undefined`
 * for a failure the server never actually weighed in on (e.g. a network/
 * timeout error caught client-side before a response came back), which stays
 * retryable. A server verdict of `false` (e.g. SCOPE_VIOLATION because the
 * record was already deleted by another device) means this specific local
 * change can never succeed no matter how many times it's retried — clearing
 * `localChangePending` immediately is what lets the delete that made it moot
 * actually apply on the next pull, instead of that pull's `apply-pull.ts`
 * guard deferring to a local edit that's already dead.
 */
export async function markFailed(
  scope: IdbTransactionScope,
  id: string,
  error: string,
  serverRetryable?: boolean
): Promise<void> {
  const existing = await getRecord<OutboxEvent>(scope, OUTBOX_STORE, id);
  if (!existing) return;
  const retryable = serverRetryable !== false;
  await putRecord(scope, OUTBOX_STORE, {
    ...existing,
    tries: existing.tries + 1,
    lastError: error,
    lastAttemptedAt: new Date(),
    retryable,
  });
  if (!retryable) await clearLocalChangePending(scope, existing.versionMetaId);
}
