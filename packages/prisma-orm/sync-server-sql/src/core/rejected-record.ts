import type { GetKeyField, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import type { SqlPushResult } from "./push";
import type { SqlPushWireEvent } from "./apply-push";
import { resolvePullRecord } from "./resolve-pull-record";
import { WireValidationError } from "./wire-values";

/** The wire key an event targets, read straight from its payload (even when the rest of the payload is malformed). */
function wireKeyOf(event: SqlPushWireEvent, keyField: string): unknown {
  const { payload } = event;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return event.operation === "create"
    ? (payload as Record<string, unknown>)[keyField]
    : (payload as { key?: unknown }).key;
}

/**
 * The row a rejected event targeted, as `scopeKey` may read it now: the same
 * ownership check and lookup as a pull. `null` means deleted or not theirs.
 * `undefined` means the server cannot say (an unknown model or an undecodable key).
 */
async function readCurrentRecord(
  db: unknown,
  syncServer: SyncServer,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  scopeKey: string,
  event: SqlPushWireEvent
): Promise<Record<string, unknown> | null | undefined> {
  const keyField = getKeyField(contract, event.entityType);
  const key = wireKeyOf(event, keyField);
  if (key === undefined) return undefined;
  const { check } = syncServer.buildPullQueries([{ changelogId: event.id, model: event.entityType, key }], {
    scopeKey,
  })[0]!;
  if (check.kind === "unknown-model") return undefined;
  // "update", so a rejected delete reports the row that still exists.
  return resolvePullRecord(db, contract, getKeyField, event.entityType, check, key, "update");
}

/**
 * Adds the target row's current state to a non-retryable failure, so the
 * client can replace its rejected local write with it. Any failure to read it
 * leaves the result as it was: the client then falls back to pulling.
 */
export async function withCurrentRecord(
  db: unknown,
  syncServer: SyncServer,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  scopeKey: string,
  event: SqlPushWireEvent,
  result: SqlPushResult
): Promise<SqlPushResult> {
  if (result.success || result.retryable !== false) return result;
  try {
    const record = await readCurrentRecord(db, syncServer, contract, getKeyField, scopeKey, event);
    return record === undefined ? result : { ...result, record };
  } catch (err) {
    // An undecodable key is the client's mistake, not a server fault worth logging.
    if (err instanceof WireValidationError) return result;
    console.error(`could not read the current record for rejected event ${event.id}`, err);
    return result;
  }
}
