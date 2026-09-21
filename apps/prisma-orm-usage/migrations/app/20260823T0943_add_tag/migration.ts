#!/usr/bin/env -S npx tsx
import { Migration, MigrationCLI, createIndexOp, createObjectStoreOp } from "@prisma-idb/target-idb/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: "122c98a5111c07549f24a259e93c2db8bcdd68bf1ee5310718c618ddd9fe8a0d",
      to: "fc8ba5682814d9f05d17d2e547a2e1f6d261bd40be8b43ae981e5880717c57ee",
    };
  }

  override get operations() {
    return [
      createObjectStoreOp("tags", { keyPath: "id", indexes: { byPostId: { keyPath: "postId" } } }),
      createIndexOp("tags", "byPostId", { keyPath: "postId" }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
