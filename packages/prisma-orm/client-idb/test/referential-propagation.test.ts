import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import family from "@prisma-idb/family-idb/pack";
import target from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbContract } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function open(contract: IdbContract) {
  return createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `referential-propagation-${crypto.randomUUID()}`,
  });
}

const child = {
  store: "children",
  key: "id",
  fields: { id: "String", parentId: "String?" },
  indexes: { parentId: { keyPath: "parentId", unique: true } },
  relations: {
    parent: {
      to: "Parent",
      cardinality: "N:1",
      on: { local: ["parentId"], target: ["id"] },
      onDelete: "setNull",
    },
  },
} as const;

it("ignores a downstream reference from the row being deleted", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: {
          store: "parents",
          key: "id",
          fields: { id: "String", childKey: "String?" },
          relations: {
            child: {
              to: "Child",
              cardinality: "N:1",
              onUpdate: "restrict",
              on: { local: ["childKey"], target: ["parentId"] },
            },
          },
        },
        Child: child,
      },
    })
  );
  try {
    await client.orm["parents"]!.create({ id: "p1", childKey: null });
    await client.orm["children"]!.create({ id: "c1", parentId: "p1" });
    await client.orm["parents"]!.where({ id: "p1" }).update({ childKey: "p1" });
    await client.orm["parents"]!.delete("p1");
    expect(await client.orm["parents"]!.findUnique("p1")).toBeNull();
    expect(await client.orm["children"]!.findUnique("c1")).toEqual({ id: "c1", parentId: null });
  } finally {
    await client.close();
  }
});

it("does not validate a cascade patch when there are no matching descendants", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: { store: "parents", key: "id", fields: { id: "String" } },
        Child: child,
        Grandchild: {
          store: "grandchildren",
          key: "id",
          fields: { id: "String", childKey: "String" },
          relations: {
            child: {
              to: "Child",
              cardinality: "N:1",
              onUpdate: "cascade",
              on: { local: ["childKey"], target: ["parentId"] },
            },
          },
        },
      },
    })
  );
  try {
    await client.orm["parents"]!.create({ id: "p1" });
    await client.orm["children"]!.create({ id: "c1", parentId: "p1" });
    await client.orm["parents"]!.delete("p1");
    expect(await client.orm["children"]!.findUnique("c1")).toEqual({ id: "c1", parentId: null });
  } finally {
    await client.close();
  }
});

it("clears Decimal-keyed children without rescanning their store for each row", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: {
          store: "parents",
          key: "id",
          fields: { id: "String" },
          relations: {
            children: {
              to: "Child",
              cardinality: "1:N",
              onDelete: "setNull",
              on: { local: ["id"], target: ["parentId"] },
            },
          },
        },
        Child: { store: "children", key: "id", fields: { id: "Decimal", parentId: "String?" } },
      },
    })
  );
  const original = IDBObjectStore.prototype.openCursor;
  let scans = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<typeof original>
  ) {
    if (this.name === "children" && args[0] == null) scans++;
    return original.apply(this, args);
  });
  try {
    await client.orm["parents"]!.create({ id: "p1" });
    await client.orm["children"]!.createAll(
      Array.from({ length: 12 }, (_, i) => ({ id: String(i), parentId: "p1" }))
    ).toArray();
    scans = 0;
    await client.orm["parents"]!.delete("p1");
    expect(scans).toBeLessThanOrEqual(3);
    const children = await client.orm["children"]!.all().toArray();
    expect(children.map((row) => row["parentId"])).toEqual(Array.from({ length: 12 }, () => null));
  } finally {
    spy.mockRestore();
    await client.close();
  }
});
