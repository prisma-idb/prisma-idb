import { transformRecord } from "@prisma-idb/target-idb/runtime";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import type { OutboxEvent } from "../types";
import { OUTBOX_STORE } from "./outbox-store";

/** Rewrite pending payloads in the app store's upgrade transaction. */
export const transformOutbox: NonNullable<IdbExtensionSpace["onTransformRecords"]> = (tx, op, modelName, onDone) => {
  const request = tx.objectStore(OUTBOX_STORE).openCursor();
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (!cursor) {
        onDone();
        return;
      }
      const event = cursor.value as OutboxEvent;
      if (!event.synced && event.retryable && event.entityType === modelName) {
        if (event.operation === "create") {
          cursor.update({ ...event, payload: transformRecord(op, event.payload as Record<string, unknown>, "full") });
        } else if (event.operation === "update") {
          const payload = event.payload as { key: unknown; patch: Record<string, unknown> };
          cursor.update({ ...event, payload: { ...payload, patch: transformRecord(op, payload.patch, "patch") } });
        }
      }
      cursor.continue();
    } catch (error) {
      // A bad queued value aborts the upgrade, which rolls back the app store and every rewritten event.
      onDone(error);
    }
  };
};
