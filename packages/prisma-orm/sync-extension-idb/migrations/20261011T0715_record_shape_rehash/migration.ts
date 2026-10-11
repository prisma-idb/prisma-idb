#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "c2c485fabf1d79f78fdaf74a1c4dd94fe4e3981493233534e003c613f643945d",
      to: "20005ac86953ae2786743ec34740cfeae4a653c80c9d7ad7f387bc81c73b87cf",
    };
  }

  override get operations() {
    return [
      // Rehash record metadata without changing stored rows or DDL.
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
