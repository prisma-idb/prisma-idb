#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createIndexOp, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: null,
      to: "f57f9cb96b36d6251be55bf297614dd74dab0861b6f77b83991c0dca40ca59dd",
    };
  }

  override get operations() {
    return [
      createObjectStoreOp("_prisma_next_marker", { keyPath: "space" }),
      createObjectStoreOp("board", { keyPath: "id", indexes: { userId: { keyPath: "userId" } } }),
      createIndexOp("board", "userId", { keyPath: "userId" }),
      createObjectStoreOp("todo", { keyPath: "id", indexes: { boardId: { keyPath: "boardId" } } }),
      createIndexOp("todo", "boardId", { keyPath: "boardId" }),
      createObjectStoreOp("user", { keyPath: "id", indexes: { email_unique: { keyPath: "email", unique: true } } }),
      createIndexOp("user", "email_unique", { keyPath: "email", unique: true }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
