import type { GetKeyField, SyncServer, SyncPushEvent, SyncServerContract } from "@prisma-idb/sync-server";
import { applyPushEvent, toSyncPushPayload, reviveWireValues, PushPayloadValidationError } from "./push";
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
 * The `reason` union may gain new values in future releases; callers should
 * handle each known reason explicitly and review new values when upgrading.
 */
export type ApplyPushOutcome =
  | { readonly ok: true; readonly results: readonly SqlPushResult[] }
  | { readonly ok: false; readonly reason: "batch-too-large"; readonly maxBatchSize: number; readonly received: number }
  | { readonly ok: false; readonly reason: "duplicate-event-id"; readonly eventId: string };

/**
 * Validates and applies a whole push batch, one call. Results are returned in
 * `events` order: an unknown entity type or unsupported
 * operation fails only that event (non-retryable), never the batch.
 *
 * Events are applied sequentially, not concurrently: a batch can carry data
 * dependencies (a Todo created right after the Board it belongs to), and
 * running them concurrently makes the Todo's ownership walk race the Board's
 * not-yet-committed transaction.
 * Stop at the first retryable failure, including its result but omitting all
 * later events. The client keeps omitted events pending without counting a
 * try, so dependent events can succeed after their parent is retried.
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
      const wirePayload = keyField === undefined ? {} : toSyncPushPayload(event.operation, event.payload, keyField);
      pushEvents.push({
        id: event.id,
        model: event.entityType,
        operation: event.operation,
        wirePayload,
        payload: reviveWireValues(contract, event.entityType, wirePayload, keyField),
      });
    } catch (err) {
      resolved.set(event.id, {
        id: event.id,
        success: false,
        error:
          err instanceof PushPayloadValidationError
            ? err.code
            : err instanceof Error
              ? err.message
              : "Unsupported event",
        retryable: false,
      });
    }
  }

  const checksById = new Map(
    syncServer.validatePush(pushEvents, { scopeKey }).map((validation) => [validation.eventId, validation])
  );
  const results: SqlPushResult[] = [];
  for (const event of events) {
    let result = resolved.get(event.id);
    if (!result) {
      const { model, check } = checksById.get(event.id)!;
      result = await applyPushEvent(db, contract, getKeyField, event, model, check, scopeKey);
    }
    results.push(result);
    if (!result.success && result.retryable) break;
  }

  return { ok: true, results };
}
