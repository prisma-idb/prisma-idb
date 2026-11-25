/**
 * The server applies pushed events one at a time, in outbox order, and checks
 * each row's foreign keys as it goes. When an update changes a key that other
 * rows reference, the parent's event has to come first: a child pointed at
 * the new key before the parent has it would be rejected.
 */
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient, getNextBatch } from "../src/exports/client";
import { OUTBOX_STORE, VERSION_META_STORE, asAccessors, openTestDb, testDbName } from "./helpers";

/** Board.code ← Card.boardCode (unique) ← Note.cardBoardCode, both `onUpdate: cascade`; Card also `onDelete: setNull`. */
async function setup() {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Board: {
        store: "boards",
        key: "id",
        fields: { id: "String", code: "String" },
        indexes: { code: { keyPath: "code", unique: true } },
        relations: {
          cards: { to: "Card", cardinality: "1:N", on: { local: ["code"], target: ["boardCode"] } },
        },
      },
      Card: {
        store: "cards",
        key: "id",
        fields: { id: "String", boardCode: "String?" },
        indexes: { boardCode: { keyPath: "boardCode", unique: true } },
        relations: {
          board: {
            to: "Board",
            cardinality: "N:1",
            on: { local: ["boardCode"], target: ["code"] },
            onUpdate: "cascade",
            onDelete: "setNull",
          },
        },
      },
      Note: {
        store: "notes",
        key: "id",
        fields: { id: "String", cardBoardCode: "String?" },
        relations: {
          card: {
            to: "Card",
            cardinality: "N:1",
            on: { local: ["cardBoardCode"], target: ["boardCode"] },
            onUpdate: "cascade",
          },
        },
      },
    },
  }) as unknown as IdbContract;
  const dbName = testDbName();
  (
    await openTestDb(dbName, [
      { name: "boards", keyPath: "id", indexes: [{ name: "code", keyPath: "code", unique: true }] },
      { name: "cards", keyPath: "id", indexes: [{ name: "boardCode", keyPath: "boardCode", unique: true }] },
      { name: "notes", keyPath: "id", indexes: [{ name: "cardBoardCode", keyPath: "cardBoardCode" }] },
      OUTBOX_STORE,
      VERSION_META_STORE,
    ])
  ).close();
  const client = createSyncIdbClient({ contract, dbName });
  const orm = asAccessors(client.orm);
  await orm["boards"]!.create({ id: "b1", code: "old" });
  await orm["boards"]!.create({ id: "b2", code: "other" });
  await orm["cards"]!.create({ id: "c1", boardCode: "old" });
  await orm["notes"]!.create({ id: "n1", cardBoardCode: "old" });
  return { client, orm };
}

type Orm = ReturnType<typeof asAccessors>;
type Rel = { connect(where: unknown): unknown; disconnect(criteria?: unknown[]): unknown };

describe("outbox order of onUpdate actions", () => {
  it.each([
    ["update", (orm: ReturnType<typeof asAccessors>) => orm["boards"]!.where({ id: "b1" }).update({ code: "new" })],
    [
      "updateAll",
      (orm: ReturnType<typeof asAccessors>) => orm["boards"]!.where({ id: "b1" }).updateAll({ code: "new" }).toArray(),
    ],
    [
      "upsert",
      (orm: ReturnType<typeof asAccessors>) =>
        orm["boards"]!.upsert({ where: { id: "b1" }, create: { id: "b1", code: "new" }, update: { code: "new" } }),
    ],
    [
      "nested update",
      (orm: Orm) =>
        orm["boards"]!.where({ id: "b1" }).update({ code: "new", cards: (rel: Rel) => rel.connect([]) } as never),
    ],
  ])("writes the parent's key change before the children it cascades to (%s)", async (_name, write) => {
    const { client, orm } = await setup();
    try {
      await write(orm);

      const events = (await getNextBatch(client.rawClient, { limit: 20 })).filter((e) => e.operation === "update");
      expect(events.map((e) => e.entityType)).toEqual(["Board", "Card", "Note"]);
      expect(await orm["boards"]!.findUnique("b1")).toEqual({ id: "b1", code: "new" });
      expect(await orm["cards"]!.findUnique("c1")).toEqual({ id: "c1", boardCode: "new" });
      expect(await orm["notes"]!.findUnique("n1")).toEqual({ id: "n1", cardBoardCode: "new" });
    } finally {
      await client.close();
    }
  });

  it.each([
    [
      "connect",
      (orm: Orm) =>
        orm["boards"]!.where({ id: "b2" }).update({ cards: (rel: Rel) => rel.connect({ id: "c1" }) } as never),
      "other",
    ],
    [
      "disconnect",
      (orm: Orm) => orm["boards"]!.where({ id: "b1" }).update({ cards: (rel: Rel) => rel.disconnect() } as never),
      null,
    ],
  ])("writes a nested %s's foreign key before the children it cascades to", async (_name, write, code) => {
    const { client, orm } = await setup();
    try {
      await write(orm);

      const events = (await getNextBatch(client.rawClient, { limit: 20 })).filter((e) => e.operation === "update");
      expect(events.map((e) => e.entityType)).toEqual(["Card", "Note"]);
      expect(await orm["notes"]!.findUnique("n1")).toEqual({ id: "n1", cardBoardCode: code });
    } finally {
      await client.close();
    }
  });

  it("writes a child's cleared key before the grandchildren it cascades to, and the parent's delete last", async () => {
    const { client, orm } = await setup();
    try {
      await orm["boards"]!.delete("b1");

      const events = await getNextBatch(client.rawClient, { limit: 20 });
      expect(events.slice(-3).map((e) => [e.entityType, e.operation])).toEqual([
        ["Card", "update"],
        ["Note", "update"],
        ["Board", "delete"],
      ]);
      expect(await orm["notes"]!.findUnique("n1")).toEqual({ id: "n1", cardBoardCode: null });
    } finally {
      await client.close();
    }
  });
});
