import { transformRecord } from "@prisma-idb/target-idb/runtime";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import type { OutboxEvent } from "../types";
import { OUTBOX_STORE } from "./outbox-store";

/** The payload `op` rewrites `event` to, or `undefined` for an event with no payload to rewrite (a delete). */
function rewrittenPayload(op: Parameters<typeof transformRecord>[0], event: OutboxEvent): unknown {
  if (event.operation === "create") return transformRecord(op, event.payload as Record<string, unknown>, "full");
  if (event.operation === "update") {
    const payload = event.payload as { key: unknown; patch: Record<string, unknown> };
    return { ...payload, patch: transformRecord(op, payload.patch, "patch") };
  }
  return undefined;
}

/** Rewrite unsynced payloads, pending and rejected, in the app store's upgrade transaction. */
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
      if (!event.synced && event.entityType === modelName) {
        let payload: unknown;
        try {
          payload = rewrittenPayload(op, event);
        } catch (error) {
          // A pending event will still be pushed, so a value that cannot be converted aborts the upgrade.
          // A rejected event never will be, so it stays as written instead of blocking the upgrade.
          if (event.retryable) throw error;
        }
        if (payload !== undefined) cursor.update({ ...event, payload });
      }
      cursor.continue();
    } catch (error) {
      // A bad queued value aborts the upgrade, which rolls back the app store and every rewritten event.
      onDone(error);
    }
  };
};
