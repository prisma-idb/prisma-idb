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

/** Visit only metadata whose primary key starts with this model's prefix. */
function scanModelMeta(
  store: IDBObjectStore,
  model: string,
  visit: (cursor: IDBCursorWithValue) => void,
  onDone: (error?: unknown) => void
): void {
  const prefix = `${model}::`;
  const request = store.openCursor();
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (cursor === null) {
        onDone();
        return;
      }
      // Seek by key so this also works with factories that do not supply a global IDBKeyRange.
      if (typeof cursor.key !== "string") {
        cursor.continue();
        return;
      }
      if (cursor.key < prefix) {
        cursor.continue(prefix);
        return;
      }
      if (!cursor.key.startsWith(prefix)) {
        onDone();
        return;
      }
      visit(cursor);
      cursor.continue();
    } catch (error) {
      onDone(error);
    }
  };
}

function scanOutbox(
  tx: IDBTransaction,
  visit: (cursor: IDBCursorWithValue, event: OutboxEvent) => void,
  onDone: (error?: unknown) => void
): void {
  const request = tx.objectStore(OUTBOX_STORE).openCursor();
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (cursor === null) {
        onDone();
        return;
      }
      visit(cursor, cursor.value as OutboxEvent);
      cursor.continue();
    } catch (error) {
      onDone(error);
    }
  };
}

/** Rewrite queued edits and version metadata inside the application's upgrade transaction. */
export const transformOutbox: NonNullable<IdbExtensionSpace["onTransformRecords"]> = (tx, op, modelName, onDone) => {
  const sourceModel = op.renameModel?.from ?? modelName;
  const destinationModel = op.renameModel?.to ?? modelName;
  const rename = sourceModel !== destinationModel;
  const rewritesPayload = op.fields !== undefined || op.renameFields !== undefined || op.removeFields !== undefined;

  const rewriteEvents = (): void => {
    scanOutbox(
      tx,
      (cursor, event) => {
        if (event.synced || event.entityType !== sourceModel) return;
        let next = event;
        if (rename) {
          next = { ...event, entityType: destinationModel };
          if (typeof event.versionMetaId === "string") {
            next = { ...next, versionMetaId: renamedMetaId(event.versionMetaId, sourceModel, destinationModel) };
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
      },
      (error) => {
        if (error !== undefined || !rename) {
          onDone(error);
          return;
        }
        const store = tx.objectStore(VERSION_META_STORE);
        scanModelMeta(
          store,
          sourceModel,
          (cursor) => {
            const meta = cursor.value as VersionMetaRecord;
            if (meta.model !== sourceModel) return;
            cursor.delete();
            store.add({ ...meta, id: renamedMetaId(meta.id, sourceModel, destinationModel), model: destinationModel });
          },
          onDone
        );
      }
    );
  };

  if (!rename) {
    rewriteEvents();
    return;
  }

  const retainedHistory = (): never => {
    throw new Error(
      `Cannot rename "${sourceModel}" to "${destinationModel}" because the destination has retained sync history. ` +
        "Use a fresh model name, or recover pending edits and clear the retired model's outbox and version metadata before retrying."
    );
  };
  scanModelMeta(tx.objectStore(VERSION_META_STORE), destinationModel, retainedHistory, (error) => {
    if (error !== undefined) {
      onDone(error);
      return;
    }
    scanOutbox(
      tx,
      (_cursor, event) => {
        if (event.entityType === destinationModel) retainedHistory();
      },
      (outboxError) => {
        if (outboxError !== undefined) onDone(outboxError);
        else rewriteEvents();
      }
    );
  });
};
