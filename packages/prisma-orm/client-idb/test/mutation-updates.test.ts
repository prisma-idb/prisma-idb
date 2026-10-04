/** Characterizes single-row and bulk updates that need existing compound FK values. */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient, type IdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: ["tenantId", "id"],
      fields: { tenantId: "String", id: "String" },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", tenantId: "String", authorId: "String", title: "String" },
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["tenantId", "authorId"], target: ["tenantId", "id"] } },
      },
    },
  },
});

let dbCounter = 0;
describe("updates with a partially set compound foreign key", () => {
  let client: IdbClient<typeof contract>;

  beforeEach(async () => {
    client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([contract]),
      dbName: `mutation-updates-${++dbCounter}`,
    });
    await client.orm["users"]!.createAll([
      { tenantId: "old", id: "alice" },
      { tenantId: "old", id: "bob" },
      { tenantId: "new", id: "alice" },
    ]).toArray();
    await client.orm["posts"]!.createAll([
      { id: "p1", tenantId: "old", authorId: "alice", title: "First" },
      { id: "p2", tenantId: "old", authorId: "bob", title: "Second" },
    ]).toArray();
  });

  afterEach(async () => client.close());

  it("update changes only the first match and returns null for no match", async () => {
    const updated = await client.orm["posts"]!.where({ tenantId: "old" }).update({ tenantId: "new" });
    expect(updated).toEqual({ id: "p1", tenantId: "new", authorId: "alice", title: "First" });
    expect(await client.orm["posts"]!.all().toArray()).toEqual([
      { id: "p1", tenantId: "new", authorId: "alice", title: "First" },
      { id: "p2", tenantId: "old", authorId: "bob", title: "Second" },
    ]);
    expect(await client.orm["posts"]!.where({ id: "missing" }).update({ tenantId: "new" })).toBeNull();
  });

  it("updateAll rolls back earlier matches when a later row has no matching parent", async () => {
    await expect(client.orm["posts"]!.updateAll({ tenantId: "new" }).toArray()).rejects.toThrow(/FK violation/);
    expect(await client.orm["posts"]!.all().toArray()).toEqual([
      { id: "p1", tenantId: "old", authorId: "alice", title: "First" },
      { id: "p2", tenantId: "old", authorId: "bob", title: "Second" },
    ]);

    await client.orm["users"]!.create({ tenantId: "new", id: "bob" });
    expect(await client.orm["posts"]!.updateAll({ tenantId: "new" }).toArray()).toEqual([
      { id: "p1", tenantId: "new", authorId: "alice", title: "First" },
      { id: "p2", tenantId: "new", authorId: "bob", title: "Second" },
    ]);
    expect(await client.orm["posts"]!.where({ id: "missing" }).updateAll({ tenantId: "old" }).toArray()).toEqual([]);
  });
});
