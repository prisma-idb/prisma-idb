#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createIndexOp, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: null,
      to: "c2c485fabf1d79f78fdaf74a1c4dd94fe4e3981493233534e003c613f643945d",
    };
  }

  override get operations() {
    return [
      createObjectStoreOp("_idb_sync_outbox", { keyPath: "id", indexes: { byCreatedAt: { keyPath: "createdAt" } } }),
      createIndexOp("_idb_sync_outbox", "byCreatedAt", { keyPath: "createdAt" }),
      createObjectStoreOp("_idb_sync_version_meta", { keyPath: "id" }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
