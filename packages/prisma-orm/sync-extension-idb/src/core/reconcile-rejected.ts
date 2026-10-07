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
import { getKeyPath, getStoreName } from "@prisma-idb/client-idb/orm";
import { decodePullLog } from "./apply-pull";
import { deleteRecord, getRecord, putRecord } from "./raw-store";
import { VERSION_META_STORE, versionMetaKey } from "./version-meta";
import type { OutboxEvent, PushResult, VersionMetaRecord } from "../types";

/** A rejected event's server row, decoded and validated, ready to write. */
export interface Reconciliation {
  readonly storeName: string;
  /** The rejected event's version-meta id; it holds the native key a deletion needs. */
  readonly versionMetaId: string;
  /** The server's row, or `null` if the local row must be deleted. */
  readonly record: Record<string, unknown> | null;
}

/**
 * Decodes and validates a rejected event's `record`, before any transaction
 * opens. Returns `null` if there is nothing safe to write: the server sent no
 * `record` (an old server, or it could not read the key), the event's key is
 * unknown (`versionMetaId` is `null`), or the `record` fails the client
 * contract or is not the row the event was about. The caller then leaves the
 * row for the next pull.
 */
export function planReconciliation<TContract extends IdbContract>(
  contract: TContract,
  event: OutboxEvent,
  result: PushResult
): Reconciliation | null {
  const { record } = result;
  const { versionMetaId } = event;
  if (record === undefined || versionMetaId === null) return null;
  try {
    const storeName = getStoreName(contract, event.entityType);
    if (record === null) return { storeName, versionMetaId, record: null };

    const decoded = decodePullLog(
      contract,
      {
        changelogId: event.id,
        model: event.entityType,
        operation: "update",
        keyPath: wireKeyOf(getKeyPath(contract, event.entityType), record),
        record,
      },
      false
    );
    if (!decoded?.record || versionMetaKey(event.entityType, decoded.key) !== versionMetaId) return null;
    return { storeName, versionMetaId, record: decoded.record };
  } catch {
    return null;
  }
}

/**
 * The wire key of `record`, read from its own key fields. The key cannot come
 * from `versionMetaId`: that id is JSON, which flattens native keys such as
 * `Uint8Array` into something the wire decoder rejects.
 */
function wireKeyOf(keyPath: string | readonly string[], record: Record<string, unknown>): unknown {
  return typeof keyPath === "string" ? record[keyPath] : keyPath.map((field) => record[field]);
}

/**
 * Writes the server's row over the local one. `scope` must span the
 * version-meta store and the `reconciliation`'s store. A deletion takes its
 * native key from the version-meta record, and does nothing if that record is gone.
 *
 * Does nothing while the row still has a queued local change. The server read
 * its row before that change, so writing it would undo the newer local write
 * until the next pull. The queued change's own result, or that pull, settles
 * the row. Call this after `markFailed` for the rejected event, which clears
 * the flag unless another change is queued.
 */
export async function applyReconciliation(scope: IdbTransactionScope, reconciliation: Reconciliation): Promise<void> {
  const { storeName, versionMetaId, record } = reconciliation;
  const meta = await getRecord<VersionMetaRecord>(scope, VERSION_META_STORE, versionMetaId);
  if (meta?.localChangePending) return;
  if (record !== null) {
    await putRecord(scope, storeName, record);
    return;
  }
  if (meta) await deleteRecord(scope, storeName, meta.key as IDBValidKey);
}
