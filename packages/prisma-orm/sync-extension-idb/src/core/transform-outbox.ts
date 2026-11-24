import { transformRecord } from "@prisma-idb/target-idb/runtime";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import type { OutboxEvent, VersionMetaRecord } from "../types";
import { OUTBOX_STORE } from "./outbox-store";
import { VERSION_META_STORE } from "./version-meta";

/** The payload `op` rewrites `event` to, or `undefined` for an event with no payload to rewrite (a delete). */
function rewrittenPayload(op: Parameters<typeof transformRecord>[0], event: OutboxEvent): unknown {
  if (event.operation === "create") return transformRecord(op, event.payload as Record<string, unknown>, "full");
  if (event.operation === "update") {
    const payload = event.payload as { key: unknown; patch: Record<string, unknown> };
    return { ...payload, patch: transformRecord(op, payload.patch, "patch") };
  }
  return undefined;
}

/**
 * The version-meta id `id` takes after `from` is renamed to `to`. Ids start with the model name
 * (`Model::key`), so only that prefix changes, whichever key spelling the id used.
 */
function renamedMetaId(id: string, from: string, to: string): string {
  return id.startsWith(`${from}::`) ? `${to}${id.slice(from.length)}` : id;
}

/**
 * Moves version metadata kept under a model's old name to its new name, so a pull or push after
 * a model rename finds the row's sync state. Each moved row gets the id its outbox events now name.
 */
function renameVersionMeta(tx: IDBTransaction, from: string, to: string, onDone: (error?: unknown) => void): void {
  const store = tx.objectStore(VERSION_META_STORE);
  const request = store.openCursor(IDBKeyRange.bound(`${from}::`, `${from}::\uffff`));
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (!cursor) {
        onDone();
        return;
      }
      const meta = cursor.value as VersionMetaRecord;
      if (meta.model === from) {
        cursor.delete();
        store.put({ ...meta, id: renamedMetaId(meta.id, from, to), model: to });
      }
      cursor.continue();
    } catch (error) {
      onDone(error);
    }
  };
}

/**
 * Rewrite unsynced payloads, pending and rejected, in the app store's upgrade transaction. After
 * a model rename (`op.renameModel`), events and version metadata queued under the old name move
 * to the new one, so an edit made offline before the upgrade still reaches the server.
 */
export const transformOutbox: NonNullable<IdbExtensionSpace["onTransformRecords"]> = (tx, op, modelName, onDone) => {
  const sourceModel = op.renameModel ?? modelName;
  const rewritesPayload = op.fields !== undefined || op.renameFields !== undefined || op.removeFields !== undefined;
  const request = tx.objectStore(OUTBOX_STORE).openCursor();
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (!cursor) {
        if (sourceModel === modelName) onDone();
        else renameVersionMeta(tx, sourceModel, modelName, onDone);
        return;
      }
      const event = cursor.value as OutboxEvent;
      if (!event.synced && event.entityType === sourceModel) {
        let next = event;
        if (sourceModel !== modelName) {
          next = { ...event, entityType: modelName };
          if (typeof event.versionMetaId === "string") {
            next = { ...next, versionMetaId: renamedMetaId(event.versionMetaId, sourceModel, modelName) };
          }
        }
        if (rewritesPayload) {
          try {
            const payload = rewrittenPayload(op, event);
            if (payload !== undefined) next = { ...next, payload };
          } catch (error) {
            // A pending event must migrate successfully before it can be pushed.
            if (event.retryable) throw error;
            next = { ...next, migrationError: error instanceof Error ? error.message : String(error) };
          }
        }
        if (next !== event) cursor.update(next);
      }
      cursor.continue();
    } catch (error) {
      // A bad queued value aborts the upgrade, which rolls back the app store and every rewritten event.
      onDone(error);
    }
  };
};
