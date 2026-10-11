#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "fc8ba5682814d9f05d17d2e547a2e1f6d261bd40be8b43ae981e5880717c57ee",
      to: "ba5e70fb3c7b0b9acd469fe1fe80d172e8b04319f53365c2107baac46ec41926",
    };
  }

  override get operations() {
    return [
      // Rehash record metadata without changing stored rows or DDL.
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
