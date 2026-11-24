/**
 * Updating a referenced Decimal field to a numerically equal spelling changes
 * nothing, so `onUpdate` restrict must not refuse it and cascade must not
 * rewrite the children.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbStoreAccessor } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function contractWith(onUpdate: "restrict" | "cascade") {
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Account: {
        store: "accounts",
        key: "id",
        fields: { id: "String", rate: "Decimal", name: "String" },
        relations: {
          entries: {
            to: "Entry",
            cardinality: "1:N",
            on: { local: ["rate"], target: ["accountRate"] },
            onUpdate,
          },
        },
      },
      Entry: {
        store: "entries",
        key: "id",
        fields: { id: "String", accountRate: "Decimal" },
      },
    },
  });
}

type Accessor = IdbStoreAccessor<never, never>;
type Orm = Record<string, Accessor>;
type UpdateAll = { updateAll(patch: Record<string, unknown>): { toArray(): Promise<unknown[]> } };

async function withClient(onUpdate: "restrict" | "cascade", run: (orm: Orm) => Promise<void>): Promise<void> {
  const client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contractWith(onUpdate)]),
    dbName: `decimal-ref-update-${crypto.randomUUID()}`,
  });
  try {
    const orm = client.orm as unknown as Orm;
    await orm["accounts"]!.create({ id: "a1", rate: "5", name: "Cash" } as never);
    await orm["entries"]!.create({ id: "e1", accountRate: "5" } as never);
    await run(orm);
  } finally {
    await client.close();
  }
}

const entryRates = async (orm: Orm) =>
  (await orm["entries"]!.all().toArray()).map((row) => (row as { accountRate: string }).accountRate);

describe("referenced Decimal field updated to an equal spelling", () => {
  it.each(["5.0", "5.00", "5e0", "+5", "05", "0.5e1"])(
    "restrict does not refuse a single update to %s",
    async (spelling) => {
      await withClient("restrict", async (orm) => {
        await orm["accounts"]!.where({ id: "a1" } as never).update({ rate: spelling } as never);
        const [account] = await orm["accounts"]!.all().toArray();
        expect((account as { rate: string }).rate).toBe(spelling);
        expect(await entryRates(orm)).toEqual(["5"]);
      });
    }
  );

  it("restrict does not refuse updateAll to an equal spelling", async () => {
    await withClient("restrict", async (orm) => {
      await (orm["accounts"] as unknown as UpdateAll).updateAll({ rate: "5.0" }).toArray();
      expect(await entryRates(orm)).toEqual(["5"]);
    });
  });

  it("restrict does not refuse an upsert to an equal spelling", async () => {
    await withClient("restrict", async (orm) => {
      await orm["accounts"]!.upsert({
        where: { id: "a1" },
        create: { id: "a1", rate: "5.0", name: "Cash" },
        update: { rate: "5.0" },
      } as never);
      expect(await entryRates(orm)).toEqual(["5"]);
    });
  });

  it("restrict still refuses a numerically different value", async () => {
    await withClient("restrict", async (orm) => {
      await expect(orm["accounts"]!.where({ id: "a1" } as never).update({ rate: "6" } as never)).rejects.toThrow(
        /would orphan child records/
      );
      expect(await entryRates(orm)).toEqual(["5"]);
    });
  });

  it("cascade leaves the children's stored spelling alone for an equal spelling", async () => {
    await withClient("cascade", async (orm) => {
      await orm["accounts"]!.where({ id: "a1" } as never).update({ rate: "5.0" } as never);
      expect(await entryRates(orm)).toEqual(["5"]);
    });
  });

  it("cascade still propagates a numerically different value", async () => {
    await withClient("cascade", async (orm) => {
      await orm["accounts"]!.where({ id: "a1" } as never).update({ rate: "6.0" } as never);
      expect(await entryRates(orm)).toEqual(["6.0"]);
    });
  });
});
