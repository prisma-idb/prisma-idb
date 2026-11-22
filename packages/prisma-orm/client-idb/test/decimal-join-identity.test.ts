/**
 * Decimal values that are numerically equal are one value: a foreign key
 * check accepts "1.00" for a parent "1", so joins and groups must agree.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbStoreAccessor } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Account: {
      store: "accounts",
      key: "id",
      fields: { id: "Decimal", name: "String" },
      relations: { entries: { to: "Entry", cardinality: "1:N", on: { local: ["id"], target: ["accountId"] } } },
    },
    Entry: {
      store: "entries",
      key: "id",
      fields: { id: "String", accountId: "Decimal", amount: "Decimal" },
      relations: { account: { to: "Account", cardinality: "N:1", on: { local: ["accountId"], target: ["id"] } } },
    },
  },
});

type Accessor = IdbStoreAccessor<never, never>;

describe("Decimal join and group identity", () => {
  it("joins and groups numerically equal spellings together", async () => {
    const client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([contract]),
      dbName: `decimal-join-${crypto.randomUUID()}`,
    });
    try {
      const orm = client.orm as unknown as Record<string, Accessor>;
      await orm["accounts"]!.create({ id: "1", name: "Cash" } as never);
      for (const [id, accountId, amount] of [
        ["e1", "1.00", "1"],
        ["e2", "1e0", "1.0"],
        ["e3", "1", "1e0"],
      ]) {
        await orm["entries"]!.create({ id, accountId, amount } as never);
      }

      const entries = await orm["entries"]!.include("account" as never)
        .all()
        .toArray();
      expect(entries.map((entry) => (entry as { account: { name: string } | null }).account?.name)).toEqual([
        "Cash",
        "Cash",
        "Cash",
      ]);
      const [account] = await orm["accounts"]!.include("entries" as never)
        .all()
        .toArray();
      expect((account as { entries: unknown[] }).entries).toHaveLength(3);

      const groups = await orm["entries"]!.groupBy("amount" as never).aggregate(
        (agg) =>
          ({
            count: (agg as unknown as { count(): unknown }).count(),
          }) as never
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ count: 3 });
    } finally {
      await client.close();
    }
  });
});
