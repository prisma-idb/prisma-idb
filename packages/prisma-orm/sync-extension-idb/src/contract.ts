import { defineContract } from "@prisma-idb/family-idb/contract-ts";
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
        retryable: "Boolean",
      },
      indexes: {
        byCreatedAt: { keyPath: "createdAt", unique: false },
      },
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
