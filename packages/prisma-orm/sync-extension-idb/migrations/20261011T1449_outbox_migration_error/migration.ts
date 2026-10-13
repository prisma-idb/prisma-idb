#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "20005ac86953ae2786743ec34740cfeae4a653c80c9d7ad7f387bc81c73b87cf",
      to: "cfe8e71cbb562d51109a1482ffe5f7ba966af8b14e129021f2e6e31a880ee6b1",
    };
  }

  override get operations() {
    return [
      // No record or schema operations are needed for this migration.
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
