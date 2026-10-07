/**
 * Reconciles a local write the server rejected for good with the server's
 * state, so client and server never keep diverging copies of one row.
 *
 * One rule covers create, update and delete: the local row becomes the
 * server's row from the push result's `record`, and `null` deletes it. A
 * rejected create is thereby undone, a rejected update is replaced by the
 * server's row, and a rejected delete is restored (or is a no-op if the row
 * is already gone).
 *
 * The write is raw: it adds no outbox event, so it cannot loop back to the
 * server, and it runs no referential actions. Any local child of a rejected
 * create is itself unsynced, so its own event is rejected next and reconciled
 * the same way.
 */

import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { getStoreName } from "@prisma-idb/client-idb/orm";
import { decodePullLog } from "./apply-pull";
import { deleteRecord, putRecord } from "./raw-store";
import { keyOfVersionMetaId } from "./version-meta";
import type { OutboxEvent, PushResult } from "../types";

/** A rejected event's server row, decoded and validated, ready to write. */
export interface Reconciliation {
  readonly storeName: string;
  readonly key: IDBValidKey;
  /** The server's row, or `null` if the local row must be deleted. */
  readonly record: Record<string, unknown> | null;
}

/**
 * Decodes and validates a rejected event's `record`, before any transaction
 * opens. Returns `null` if there is nothing safe to write: the server sent no
 * `record` (an old server, or it could not read the key), the event's key is
 * unknown (`versionMetaId` is `null`), or the `record` fails the client
 * contract. The caller then leaves the row for the next pull.
 */
export function planReconciliation<TContract extends IdbContract>(
  contract: TContract,
  event: OutboxEvent,
  result: PushResult
): Reconciliation | null {
  const { record } = result;
  if (record === undefined || event.versionMetaId === null) return null;
  try {
    const decoded = decodePullLog(
      contract,
      {
        changelogId: event.id,
        model: event.entityType,
        operation: record === null ? "delete" : "update",
        keyPath: keyOfVersionMetaId(event.versionMetaId, event.entityType),
        record,
      },
      record === null
    );
    if (!decoded) return null;
    return { storeName: getStoreName(contract, event.entityType), key: decoded.key, record: decoded.record };
  } catch {
    return null;
  }
}

/** Writes the server's row over the local one. `scope` must span the `reconciliation`'s store. */
export async function applyReconciliation(scope: IdbTransactionScope, reconciliation: Reconciliation): Promise<void> {
  const { storeName, key, record } = reconciliation;
  if (record === null) await deleteRecord(scope, storeName, key);
  else await putRecord(scope, storeName, record);
}
