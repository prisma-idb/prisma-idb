#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "f57f9cb96b36d6251be55bf297614dd74dab0861b6f77b83991c0dca40ca59dd",
      to: "7498e3634f22784f51916bb783fe23a341bd9031bce60cb8201fc37b97e39624",
    };
  }

  override get operations() {
    return [
      // Rehash record metadata without changing stored rows or DDL.
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
