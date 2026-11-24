import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import family from "@prisma-idb/family-idb/pack";
import target from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbContract } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function open(contract: IdbContract) {
  return createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `referential-validation-${crypto.randomUUID()}`,
  });
}

it("checks both SetDefault writes when store names and keys contain separators", async () => {
  const child = (store: string, parentDefault: string) =>
    ({
      store,
      key: "id",
      fields: { id: "String", parentId: "String" },
      fieldDefaults: { parentId: parentDefault },
      relations: {
        parent: {
          to: "Parent",
          cardinality: "N:1",
          on: { local: ["parentId"], target: ["id"] },
          onDelete: "setDefault",
        },
      },
    }) as const;

  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: { store: "parents", key: "id", fields: { id: "String" } },
        Child: child("children", "available"),
        Extra: child("children::extra", "missing"),
      },
    })
  );
  try {
    await client.orm["parents"]!.createAll([{ id: "old" }, { id: "available" }]).toArray();
    await client.orm["children"]!.create({ id: "extra::1", parentId: "old" });
    await client.orm["children::extra"]!.create({ id: "1", parentId: "old" });
    await expect(client.orm["parents"]!.delete("old")).rejects.toThrow(/does not reference a real row/);
    expect(await client.orm["parents"]!.findUnique("old")).toEqual({ id: "old" });
    expect(await client.orm["children"]!.findUnique("extra::1")).toMatchObject({ parentId: "old" });
    expect(await client.orm["children::extra"]!.findUnique("1")).toMatchObject({ parentId: "old" });
  } finally {
    await client.close();
  }
});

it("checks an overlapping foreign key declared only on the referenced model", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", tenant: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              onUpdate: "cascade",
              on: { local: ["tenant", "id"], target: ["tenant", "authorId"] },
            },
          },
        },
        Category: {
          store: "categories",
          key: ["tenant", "id"],
          fields: { tenant: "String", id: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["tenant", "id"], target: ["tenant", "categoryId"] },
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", tenant: "String", authorId: "String", categoryId: "String" },
        },
      },
    })
  );
  try {
    await client.orm["users"]!.create({ id: "u1", tenant: "old" });
    await client.orm["categories"]!.create({ tenant: "old", id: "c1" });
    await client.orm["posts"]!.create({ id: "p1", tenant: "old", authorId: "u1", categoryId: "c1" });

    const user = client.orm["users"]!.where({ id: "u1" });
    await expect(user.update({ tenant: "new" })).rejects.toThrow(/has no Category/);
    expect(await client.orm["posts"]!.findUnique("p1")).toMatchObject({ tenant: "old" });
    expect(await client.orm["users"]!.findUnique("u1")).toMatchObject({ tenant: "old" });

    await client.orm["categories"]!.create({ tenant: "new", id: "c1" });
    await user.update({ tenant: "new" });
    expect(await client.orm["posts"]!.findUnique("p1")).toMatchObject({ tenant: "new" });
  } finally {
    await client.close();
  }
});
