/**
 * Low-level read/write helpers for `_idb_sync_outbox`.
 *
 * These functions operate directly on `IdbTransactionScope` (for writes) or
 * `IdbClient` (for reads that open their own transaction). They do NOT go
 * through the ORM so as not to trigger the sync interceptor.
 */

import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbClient } from "@prisma-idb/client-idb/client";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { OutboxEvent } from "../types";

export type { OutboxEvent };

const OUTBOX = "_idb_sync_outbox";
const VERSION_META = "_idb_sync_version_meta";

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch the next batch of unsynced, retryable outbox events sorted by
 * `createdAt` ascending (oldest-first → FIFO ordering for push).
 *
 * Filters `synced`/`retryable` in-memory over a full store scan — `boolean`
 * is not a valid IndexedDB key type (still an open spec proposal:
 * https://github.com/w3c/IndexedDB/issues/76), so a `bySynced` index would
 * throw a `DataError` on any range query against it (`IDBKeyRange.only(false)`)
 * and silently omit records on write. The contract no longer declares that
 * index.
 */
export async function getNextBatch<TContract extends IdbContract>(
  client: IdbClient<TContract>,
  options?: { limit?: number }
): Promise<OutboxEvent[]> {
  const limit = options?.limit ?? 20;
  const events: OutboxEvent[] = [];

  await client.withTransaction([OUTBOX], async (scope) => {
    const rows = await scope.execute({
      kind: "cursor-scan",
      storeName: OUTBOX,
    } as unknown as IdbAtomicPlan);
    // Sort by createdAt ascending and apply limit in-memory.
    const unsorted = rows as unknown as OutboxEvent[];
    const sorted = unsorted
      .filter((e) => !e.synced && e.retryable)
      .sort((a, b) => {
        const at = (d: Date | null) => (d instanceof Date ? d.getTime() : 0);
        return at(a.createdAt) - at(b.createdAt);
      });
    for (const e of sorted.slice(0, limit)) events.push(e);
  });

  return events;
}

// ── Write helpers (inside an existing transaction scope) ──────────────────────

/**
 * True if some OTHER outbox event still references `versionMetaId` and could
 * still succeed (unsynced, retryable) — a full store scan, same as
 * `getNextBatch` (no queryable index; see that function's doc comment). The
 * event whose own write just triggered this check has already had its
 * `synced`/`retryable` field updated by the caller before this runs, so it
 * naturally doesn't match here — no need to also exclude it by id.
 */
async function hasOtherPendingOutboxEvents(scope: IdbTransactionScope, versionMetaId: string): Promise<boolean> {
  const rows = await scope.execute({
    kind: "cursor-scan",
    storeName: OUTBOX,
  } as unknown as IdbAtomicPlan);
  const events = rows as unknown as OutboxEvent[];
  return events.some((e) => e.versionMetaId === versionMetaId && !e.synced && e.retryable);
}

/**
 * Clears `localChangePending` on the version-meta row an outbox event was
 * keyed under, if any — shared by `markSynced` (the event's own write
 * succeeded) and `markFailed` (the event is dead and will never succeed, see
 * that function's doc comment). Reads the id persisted at write time
 * (`SyncInterceptorExecutor`'s `versionMetaKey(modelName, key)`) rather than
 * re-deriving it from the payload — the payload shape differs per operation
 * (create/update/delete) and re-deriving it here previously matched only
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
  const metaRows = await scope.execute({
    kind: "key-get",
    storeName: VERSION_META,
    key: versionMetaId,
  } as unknown as IdbAtomicPlan);
  const meta = metaRows[0] as Record<string, unknown> | undefined;
  if (!meta) return;
  await scope.execute({
    kind: "put",
    storeName: VERSION_META,
    record: { ...meta, localChangePending: false },
  } as unknown as IdbAtomicPlan);
}

/** Mark an outbox event as successfully synced. */
export async function markSynced(scope: IdbTransactionScope, id: string): Promise<void> {
  const rows = await scope.execute({ kind: "key-get", storeName: OUTBOX, key: id } as unknown as IdbAtomicPlan);
  const existing = rows[0] as OutboxEvent | undefined;
  if (!existing) return;
  await scope.execute({
    kind: "put",
    storeName: OUTBOX,
    record: {
      ...existing,
      synced: true,
      syncedAt: new Date(),
    } as unknown as Record<string, unknown>,
  } as unknown as IdbAtomicPlan);
  await clearLocalChangePending(scope, existing.versionMetaId);
}

/**
 * Record a push failure — increment tries, store error, mark non-retryable
 * after too many attempts OR immediately when the server says so.
 *
 * `serverRetryable` is the push result's own `retryable` flag: `undefined`
 * for a failure the server never actually weighed in on (e.g. a network/
 * timeout error caught client-side before a response came back), in which
 * case only the tries-based cap applies. A server verdict of `false` (e.g.
 * SCOPE_VIOLATION because the record was already deleted by another device)
 * means this specific local change can never succeed no matter how many
 * times it's retried — clearing `localChangePending` immediately (instead of
 * only once `tries` hits the client-side cap) is what lets the delete that
 * made it moot actually apply on the next pull, instead of that pull's
 * `apply-pull.ts` guard deferring to a local edit that's already dead.
 */
export async function markFailed(
  scope: IdbTransactionScope,
  id: string,
  error: string,
  serverRetryable?: boolean
): Promise<void> {
  const rows = await scope.execute({ kind: "key-get", storeName: OUTBOX, key: id } as unknown as IdbAtomicPlan);
  const existing = rows[0] as OutboxEvent | undefined;
  if (!existing) return;
  const tries = existing.tries + 1;
  const retryable = serverRetryable !== false && tries < 10;
  await scope.execute({
    kind: "put",
    storeName: OUTBOX,
    record: {
      ...existing,
      tries,
      lastError: error,
      lastAttemptedAt: new Date(),
      retryable,
    } as unknown as Record<string, unknown>,
  } as unknown as IdbAtomicPlan);
  if (!retryable) await clearLocalChangePending(scope, existing.versionMetaId);
}
