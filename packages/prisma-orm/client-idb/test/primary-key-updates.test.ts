import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { fieldFilter as f } from "@prisma-idb/adapter-idb/runtime";
import { createAutoMigratingIdbClient, type IdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: { id: "String", serial: "Int", label: "String" },
      indexes: { bySerial: { keyPath: "serial", unique: true } },
    },
  },
});
let counter = 0;
const original = { id: "i1", serial: 1, label: "x" };

describe("primary-key updates", () => {
  let client: IdbClient<typeof contract>;
  beforeEach(async () => {
    client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([contract]),
      dbName: `pk-updates-${++counter}`,
    });
    await client.orm["items"]!.create(original);
  });
  afterEach(async () => client.close());

  for (const [name, filter] of [
    ["unindexed filter", f("label", "eq", "x")],
    ["indexed filter", f("serial", "eq", 1)],
    ["primary-key filter", f("id", "eq", "i1")],
  ] as const) {
    for (const operation of ["update", "updateAll"] as const) {
      it(`${operation} settles and preserves the store with a ${name}`, async () => {
        const accessor = client.orm["items"]!.where(() => filter);
        const result =
          operation === "update" ? accessor.update({ id: "z9" }) : accessor.updateAll({ id: "z9" }).toArray();
        await expect(result).rejects.toMatchObject({ code: "PRIMARY_KEY_CHANGE_UNSUPPORTED" });
        await expect(result).rejects.toThrow(
          /Delete the row and create it again only after handling dependent records/
        );
        expect(await client.orm["items"]!.all().toArray()).toEqual([original]);
      }, 1000);
    }
  }

  it("allows a patch that repeats the existing primary key", async () => {
    expect(await client.orm["items"]!.updateAll({ id: "i1", label: "y" }).toArray()).toEqual([
      { ...original, label: "y" },
    ]);
  });
  it("does not reject a primary-key patch when no rows match", async () => {
    expect(await client.orm["items"]!.where({ id: "missing" }).update({ id: "z9" })).toBeNull();
    expect(await client.orm["items"]!.where({ id: "missing" }).updateAll({ id: "z9" }).toArray()).toEqual([]);
  });
  it("updateCount rejects a key change without writing", async () => {
    await expect(client.orm["items"]!.updateCount({ id: "z9" })).rejects.toMatchObject({
      code: "PRIMARY_KEY_CHANGE_UNSUPPORTED",
    });
    expect(await client.orm["items"]!.all().toArray()).toEqual([original]);
  });
  it("upsert's update arm rejects a key change without writing", async () => {
    await expect(
      client.orm["items"]!.upsert({
        where: { id: "i1" },
        create: { id: "z9", serial: 9, label: "new" },
        update: { id: "z9" },
      })
    ).rejects.toMatchObject({ code: "PRIMARY_KEY_CHANGE_UNSUPPORTED" });
    expect(await client.orm["items"]!.all().toArray()).toEqual([original]);
  });
  it("updateAll rolls back an earlier match that repeated its own key", async () => {
    const second = { id: "i2", serial: 2, label: "x" };
    await client.orm["items"]!.create(second);
    await expect(client.orm["items"]!.updateAll({ id: "i1", label: "y" }).toArray()).rejects.toMatchObject({
      code: "PRIMARY_KEY_CHANGE_UNSUPPORTED",
    });
    expect(await client.orm["items"]!.all().toArray()).toEqual([original, second]);
  });
});
