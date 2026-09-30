import type { GetKeyField, SyncServer, SyncPushEvent, SyncServerContract } from "@prisma-idb/sync-server";
import { applyPushEvent, toSyncPushPayload } from "./push";
import type { SqlPushResult } from "./push";

/**
 * Generous headroom over the browser client's own batch size (default 20) —
 * not a tuned limit, just a bound so a crafted request can't force an
 * unbounded number of sequential per-event transactions.
 */
export const DEFAULT_MAX_PUSH_BATCH_SIZE = 1000;

/**
 * One event as it arrives on the push wire. Structurally satisfied by the
 * zod-inferred `PushEventBody` from `@prisma-idb/sync-extension-idb/schemas`,
 * without this package depending on it.
 */
export interface SqlPushWireEvent {
  readonly id: string;
  readonly entityType: string;
  readonly operation: "create" | "update" | "delete";
  readonly payload: unknown;
}

export interface ApplyPushInput {
  readonly events: readonly SqlPushWireEvent[];
  /** The authenticated caller's scope (e.g. the session's user id) — never taken from the request body. */
  readonly scopeKey: string;
  /** @default DEFAULT_MAX_PUSH_BATCH_SIZE */
  readonly maxBatchSize?: number;
}

/**
 * `batch-too-large` and `duplicate-event-id` describe a request that no
 * well-behaved client sends, so the caller should reject it outright (HTTP
 * 400/413) instead of returning per-event results. Nothing was applied.
 */
export type ApplyPushOutcome =
  | { readonly ok: true; readonly results: readonly SqlPushResult[] }
  | { readonly ok: false; readonly reason: "batch-too-large"; readonly maxBatchSize: number; readonly received: number }
  | { readonly ok: false; readonly reason: "duplicate-event-id"; readonly eventId: string };

/**
 * Validates and applies a whole push batch, one call. Results are returned in
 * `events` order, one per event: an unknown entity type or unsupported
 * operation fails only that event (non-retryable), never the batch.
 *
 * Events are applied sequentially, not concurrently: a batch can carry data
 * dependencies (a Todo created right after the Board it belongs to), and
 * running them concurrently makes the Todo's ownership walk race the Board's
 * not-yet-committed transaction.
 */
export async function applyPush(
  db: unknown,
  syncServer: SyncServer,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  input: ApplyPushInput
): Promise<ApplyPushOutcome> {
  const { events, scopeKey, maxBatchSize = DEFAULT_MAX_PUSH_BATCH_SIZE } = input;

  if (events.length > maxBatchSize) {
    return { ok: false, reason: "batch-too-large", maxBatchSize, received: events.length };
  }

  // Results are matched back to events by id, which only holds up if ids
  // are unique within the batch. A client's outbox ids always are.
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) return { ok: false, reason: "duplicate-event-id", eventId: event.id };
    seen.add(event.id);
  }

  const resolved = new Map<string, SqlPushResult>();
  const pushEvents: SyncPushEvent[] = [];
  for (const event of events) {
    // A model the contract can't resolve a key for is passed through with an
    // empty payload: `validatePush` reports it as an unknown model, so it
    // fails as an ordinary non-retryable event result.
    let keyField: string | undefined;
    try {
      keyField = getKeyField(contract, event.entityType);
    } catch {
      keyField = undefined;
    }
    try {
      pushEvents.push({
        id: event.id,
        model: event.entityType,
        operation: event.operation,
        payload: keyField === undefined ? {} : toSyncPushPayload(event.operation, event.payload, keyField),
      });
    } catch (err) {
      resolved.set(event.id, {
        id: event.id,
        success: false,
        error: err instanceof Error ? err.message : "Unsupported event",
        retryable: false,
      });
    }
  }

  const eventsById = new Map(events.map((event) => [event.id, event]));
  for (const { eventId, model, check } of syncServer.validatePush(pushEvents, { scopeKey })) {
    const event = eventsById.get(eventId)!;
    resolved.set(eventId, await applyPushEvent(db, contract, getKeyField, event, model, check, scopeKey));
  }

  return { ok: true, results: events.map((event) => resolved.get(event.id)!) };
}
