#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createIndexOp, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: null,
      to: "122c98a5111c07549f24a259e93c2db8bcdd68bf1ee5310718c618ddd9fe8a0d",
    };
  }

  override get operations() {
    return [
      createObjectStoreOp("_prisma_next_marker", { keyPath: "space" }),
      createObjectStoreOp("posts", { keyPath: "id", indexes: { byAuthorId: { keyPath: "authorId" } } }),
      createIndexOp("posts", "byAuthorId", { keyPath: "authorId" }),
      createObjectStoreOp("random_store", { keyPath: "id" }),
      createObjectStoreOp("users", {
        keyPath: "id",
        indexes: { byEmail: { keyPath: "email", unique: true }, byScore: { keyPath: "score" } },
      }),
      createIndexOp("users", "byEmail", { keyPath: "email", unique: true }),
      createIndexOp("users", "byScore", { keyPath: "score" }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
