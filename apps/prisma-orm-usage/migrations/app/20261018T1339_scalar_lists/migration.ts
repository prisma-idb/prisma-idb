#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "ba5e70fb3c7b0b9acd469fe1fe80d172e8b04319f53365c2107baac46ec41926",
      to: "8e2267b235c95e5e2f0ea8ae67fabfac6f84a393224b811a2de007e303fecc83",
    };
  }

  override get operations() {
    return [createObjectStoreOp("scalar_list_samples", { keyPath: "id" })];
  }
}

MigrationCLI.run(import.meta.url, M);
