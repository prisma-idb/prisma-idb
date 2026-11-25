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

it("uses the current join values when an earlier child action rewrites another selected child", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: { store: "parents", key: "id", fields: { id: "String" } },
        Child: {
          ...child,
          fields: { ...child.fields, slot: "String", linkedSlot: "String?" },
          indexes: { parentSlot: { keyPath: ["parentId", "slot"], unique: true } },
          fieldDefaults: { parentId: "new", linkedSlot: "fallback" },
          relations: {
            ...child.relations,
            linked: {
              to: "Child",
              cardinality: "N:1",
              onUpdate: "setDefault",
              on: { local: ["parentId", "linkedSlot"], target: ["parentId", "slot"] },
            },
          },
        },
        Grandchild: {
          store: "grandchildren",
          key: "id",
          fields: { id: "String", childKey: "String?", childSlot: "String" },
          relations: {
            child: {
              to: "Child",
              cardinality: "N:1",
              onUpdate: "cascade",
              on: { local: ["childKey", "childSlot"], target: ["parentId", "slot"] },
            },
          },
        },
      },
    })
  );
  try {
    await client.orm["parents"]!.createAll([{ id: "old" }, { id: "new" }]).toArray();
    await client.orm["children"]!.createAll([
      { id: "fallback", parentId: "new", slot: "fallback", linkedSlot: null },
      { id: "b1", parentId: "old", slot: "1", linkedSlot: null },
      { id: "b2", parentId: "old", slot: "2", linkedSlot: "1" },
    ]).toArray();
    await client.orm["grandchildren"]!.create({ id: "g", childKey: "old", childSlot: "2" });
    await client.orm["parents"]!.delete("old");
    expect(await client.orm["children"]!.findUnique("b2")).toMatchObject({ parentId: null, slot: "2" });
    expect(await client.orm["grandchildren"]!.findUnique("g")).toMatchObject({ childKey: null, childSlot: "2" });
  } finally {
    await client.close();
  }
});

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

it("uses updated preimages for later rows in a bulk cascade", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: {
          store: "parents",
          key: "id",
          fields: { id: "String", tenant: "String", code: "String", ownerTenant: "String?", ownerCode: "String?" },
          indexes: {
            tenantCode: { keyPath: ["tenant", "code"], unique: true },
            codeOwnerCode: { keyPath: ["code", "ownerCode"], unique: true },
          },
          relations: {
            owner: {
              to: "Parent",
              cardinality: "N:1",
              onUpdate: "cascade",
              on: { local: ["ownerTenant", "ownerCode"], target: ["tenant", "code"] },
            },
          },
        },
        Child: {
          store: "children",
          key: "id",
          fields: { id: "String", parentCode: "String", parentOwnerCode: "String" },
          relations: {
            parent: {
              to: "Parent",
              cardinality: "N:1",
              onUpdate: "cascade",
              on: { local: ["parentCode", "parentOwnerCode"], target: ["code", "ownerCode"] },
            },
          },
        },
      },
    })
  );
  try {
    await client.orm["parents"]!.createAll([
      { id: "a", tenant: "ta", code: "old-a", ownerTenant: null, ownerCode: null },
      { id: "b", tenant: "tb", code: "old-b", ownerTenant: "ta", ownerCode: "old-a" },
    ]).toArray();
    await client.orm["children"]!.create({ id: "c", parentCode: "old-b", parentOwnerCode: "old-a" });
    await client.orm["parents"]!.where({}).updateAll({ code: "new" }).toArray();
    expect(await client.orm["children"]!.findUnique("c")).toMatchObject({ parentCode: "new", parentOwnerCode: "new" });
  } finally {
    await client.close();
  }
});

it("uses current referenced fields when a recursive delete rewrote a selected sibling", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Group: { store: "groups", key: "id", fields: { id: "String" } },
        Node: {
          store: "nodes",
          key: "id",
          fields: { id: "String", groupId: "String", peerId: "String?" },
          indexes: { idPeer: { keyPath: ["id", "peerId"], unique: true } },
          fieldDefaults: { peerId: "fallback" },
          relations: {
            group: {
              to: "Group",
              cardinality: "N:1",
              onDelete: "cascade",
              on: { local: ["groupId"], target: ["id"] },
            },
            peer: {
              to: "Node",
              cardinality: "N:1",
              onDelete: "setDefault",
              on: { local: ["peerId"], target: ["id"] },
            },
          },
        },
        Leaf: {
          store: "leaves",
          key: "id",
          fields: { id: "String", nodeId: "String", peerKey: "String?" },
          relations: {
            node: {
              to: "Node",
              cardinality: "N:1",
              onUpdate: "cascade",
              onDelete: "cascade",
              on: { local: ["nodeId", "peerKey"], target: ["id", "peerId"] },
            },
          },
        },
      },
    })
  );
  try {
    await client.orm["groups"]!.createAll([{ id: "g" }, { id: "other" }]).toArray();
    await client.orm["nodes"]!.createAll([
      { id: "a", groupId: "g", peerId: null },
      { id: "b", groupId: "g", peerId: "a" },
      { id: "fallback", groupId: "other", peerId: null },
    ]).toArray();
    await client.orm["leaves"]!.create({ id: "l", nodeId: "b", peerKey: "a" });
    await client.orm["groups"]!.delete("g");
    expect(await client.orm["leaves"]!.findUnique("l")).toBeNull();
    expect(await client.orm["nodes"]!.findUnique("fallback")).toMatchObject({ groupId: "other" });
  } finally {
    await client.close();
  }
});

it.each(["setDefault", "cascade"] as const)(
  "finishes the deleting row's later actions after a recursive %s",
  async (action) => {
    const client = await open(
      defineContract({
        family,
        target,
        models: {
          Group: {
            store: "groups",
            key: "id",
            fields: { id: "String", leaderId: "String?" },
            indexes: { idLeader: { keyPath: ["id", "leaderId"], unique: true } },
            fieldDefaults: { leaderId: "fallback" },
            relations: {
              nodes: {
                to: "Node",
                cardinality: "1:N",
                onDelete: "cascade",
                on: { local: ["id"], target: ["groupId"] },
              },
              leader: { to: "Node", cardinality: "N:1", onDelete: action, on: { local: ["leaderId"], target: ["id"] } },
            },
          },
          Node: {
            store: "nodes",
            key: "id",
            fields: { id: "String", groupId: "String" },
            relations: { group: { to: "Group", cardinality: "N:1", on: { local: ["groupId"], target: ["id"] } } },
          },
          Leaf: {
            store: "leaves",
            key: "id",
            fields: { id: "String", groupId: "String", leaderKey: "String?" },
            relations: {
              group: {
                to: "Group",
                cardinality: "N:1",
                onUpdate: "cascade",
                onDelete: "cascade",
                on: { local: ["groupId", "leaderKey"], target: ["id", "leaderId"] },
              },
            },
          },
        },
      })
    );
    try {
      await client.orm["groups"]!.createAll([
        { id: "g", leaderId: null },
        { id: "other", leaderId: null },
      ]).toArray();
      await client.orm["nodes"]!.createAll([
        { id: "a", groupId: "g" },
        { id: "fallback", groupId: "other" },
      ]).toArray();
      await client.orm["groups"]!.where({ id: "g" }).update({ leaderId: "a" });
      await client.orm["leaves"]!.create({ id: "l", groupId: "g", leaderKey: "a" });
      await client.orm["groups"]!.delete("g");
      expect(await client.orm["leaves"]!.findUnique("l")).toBeNull();
      expect(await client.orm["nodes"]!.findUnique("fallback")).toMatchObject({ groupId: "other" });
    } finally {
      await client.close();
    }
  }
);

it.each([false, true])(
  "restrict ignores only rows already being deleted (surviving reference: %s)",
  async (survives) => {
    const client = await open(
      defineContract({
        family,
        target,
        models: {
          Group: {
            store: "groups",
            key: "id",
            fields: { id: "String", leaderId: "String?", guardId: "String?" },
            relations: {
              nodes: {
                to: "Node",
                cardinality: "1:N",
                onDelete: "cascade",
                on: { local: ["id"], target: ["groupId"] },
              },
              aLeader: {
                to: "Node",
                cardinality: "N:1",
                onDelete: "cascade",
                on: { local: ["leaderId"], target: ["id"] },
              },
              zGuard: {
                to: "Node",
                cardinality: "N:1",
                onDelete: "restrict",
                on: { local: ["guardId"], target: ["id"] },
              },
            },
          },
          Node: {
            store: "nodes",
            key: "id",
            fields: { id: "String", groupId: "String" },
            relations: { group: { to: "Group", cardinality: "N:1", on: { local: ["groupId"], target: ["id"] } } },
          },
        },
      })
    );
    try {
      await client.orm["groups"]!.create({ id: "g", leaderId: null, guardId: null });
      await client.orm["nodes"]!.create({ id: "a", groupId: "g" });
      await client.orm["groups"]!.where({ id: "g" }).update({ leaderId: "a", guardId: "a" });
      if (survives) {
        await client.orm["groups"]!.create({ id: "other", leaderId: null, guardId: "a" });
        await expect(client.orm["groups"]!.delete("g")).rejects.toThrow(/zGuard/);
        expect(await client.orm["groups"]!.findUnique("g")).toMatchObject({ guardId: "a" });
        expect(await client.orm["nodes"]!.findUnique("a")).toMatchObject({ groupId: "g" });
      } else {
        await client.orm["groups"]!.delete("g");
        expect(await client.orm["groups"]!.findUnique("g")).toBeNull();
        expect(await client.orm["nodes"]!.findUnique("a")).toBeNull();
      }
    } finally {
      await client.close();
    }
  }
);

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
