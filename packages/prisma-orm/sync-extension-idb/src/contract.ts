import { autoincrement, defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";

export const syncContract = defineContract({
  family: idbFamily,
  target: idbTarget,
  models: {
    OutboxEvent: {
      store: "_idb_sync_outbox",
      key: "id",
      fields: {
        id: "String",
        entityType: "String",
        operation: "String",
        payload: "Json",
        createdAt: "DateTime",
        synced: "Boolean",
        syncedAt: "DateTime?",
        lastAttemptedAt: "DateTime?",
        tries: "Int",
        lastError: "String?",
        migrationError: "String?",
        retryable: "Boolean",
        versionMetaId: "String?",
      },
      indexes: {
        byCreatedAt: { keyPath: "createdAt", unique: false },
      },
    },
    // The outbox's push order. IndexedDB's key generator assigns `seq`, so the
    // order survives reloads and doesn't depend on the clock or the tab.
    OutboxOrder: {
      store: "_idb_sync_outbox_order",
      key: "seq",
      fields: { seq: "Int", eventId: "String" },
      defaults: { seq: autoincrement() },
      indexes: {
        byEventId: { keyPath: "eventId", unique: true },
      },
    },
    SyncMeta: {
      store: "_idb_sync_meta",
      key: "id",
      fields: { id: "String", value: "String" },
    },
    VersionMeta: {
      store: "_idb_sync_version_meta",
      key: "id",
      fields: {
        id: "String",
        model: "String",
        key: "Json",
        lastAppliedChangeId: "String?",
        localChangePending: "Boolean",
      },
    },
  },
});
