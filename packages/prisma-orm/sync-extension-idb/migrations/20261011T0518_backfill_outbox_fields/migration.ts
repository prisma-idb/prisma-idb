#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, defaultIfMissing, transformRecordsOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "c2c485fabf1d79f78fdaf74a1c4dd94fe4e3981493233534e003c613f643945d",
      to: "c2c485fabf1d79f78fdaf74a1c4dd94fe4e3981493233534e003c613f643945d",
    };
  }

  override get operations() {
    return [
      transformRecordsOp("_idb_sync_outbox", {
        fields: {
          migrationError: defaultIfMissing(null),
          versionMetaId: defaultIfMissing(null),
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
