#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createIndexOp, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "609932199fd5710d371fa966650a1806c1f587c912ff9d8c40f7b2efd84eed70",
      to: "7d2923d8d5964d8ff9e6a0ceeb87819828634eaaecc037b3617c0d71e99587aa",
    };
  }

  override get operations() {
    return [
      createObjectStoreOp("_idb_sync_outbox_order", {
        keyPath: "seq",
        autoIncrement: true,
        indexes: { byEventId: { keyPath: "eventId", unique: true } },
      }),
      createIndexOp("_idb_sync_outbox_order", "byEventId", { keyPath: "eventId", unique: true }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
