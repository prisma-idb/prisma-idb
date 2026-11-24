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
