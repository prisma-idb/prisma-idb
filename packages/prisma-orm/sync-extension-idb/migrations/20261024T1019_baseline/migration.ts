#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createIndexOp, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

/** Creates all sync stores for a fresh browser database. */
export default class M extends Migration {
  /** Pins the baseline to the emitted sync contract. */
  override describe() {
    return {
      from: null,
      to: "609932199fd5710d371fa966650a1806c1f587c912ff9d8c40f7b2efd84eed70",
    };
  }

  /** Includes the outbox ordering index used when sending queued writes. */
  override get operations() {
    return [
      createObjectStoreOp("_idb_sync_meta", { keyPath: "id" }),
      createObjectStoreOp("_idb_sync_outbox", { keyPath: "id", indexes: { byCreatedAt: { keyPath: "createdAt" } } }),
      createIndexOp("_idb_sync_outbox", "byCreatedAt", { keyPath: "createdAt" }),
      createObjectStoreOp("_idb_sync_version_meta", { keyPath: "id" }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
