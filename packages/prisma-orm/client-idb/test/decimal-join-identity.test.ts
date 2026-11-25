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
      fields: { id: "String", accountId: "Decimal", amount: "Decimal", amounts: "Decimal[]" },
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
        await orm["entries"]!.create({ id, accountId, amount, amounts: [] } as never);
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

  it("groups Decimal lists by element value while preserving order, length and the first spelling", async () => {
    const client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([contract]),
      dbName: `decimal-list-group-${crypto.randomUUID()}`,
    });
    try {
      const orm = client.orm as unknown as Record<string, Accessor>;
      await orm["accounts"]!.create({ id: "1", name: "Cash" } as never);
      const lists = [["1.00", "2"], ["1e0", "2.0"], ["2", "1"], ["1"]];
      for (const [index, amounts] of lists.entries()) {
        await orm["entries"]!.create({ id: `e${index}`, accountId: "1", amount: "1", amounts } as never);
      }

      const groups = await orm["entries"]!.groupBy("amounts" as never).aggregate(
        (agg) =>
          ({
            count: (agg as unknown as { count(): unknown }).count(),
          }) as never
      );
      expect(groups).toEqual([
        { amounts: ["1.00", "2"], count: 2 },
        { amounts: ["2", "1"], count: 1 },
        { amounts: ["1"], count: 1 },
      ]);
    } finally {
      await client.close();
    }
  });
});

const compoundContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Ledger: {
      store: "ledgers",
      key: "id",
      fields: { id: "String", rate: "Decimal", region: "String", at: "DateTime", name: "String" },
      relations: {
        byRegion: {
          to: "Line",
          cardinality: "1:N",
          on: { local: ["rate", "region"], target: ["rate", "region"] },
        },
        byTime: {
          to: "Line",
          cardinality: "1:N",
          on: { local: ["rate", "at"], target: ["rate", "at"] },
        },
      },
    },
    Booking: {
      store: "bookings",
      key: "id",
      fields: { id: "String", rate: "Decimal?", region: "String" },
      relations: {
        ledger: {
          to: "Ledger",
          cardinality: "N:1",
          on: { local: ["rate", "region"], target: ["rate", "region"] },
          index: false,
        },
      },
    },
    Line: {
      store: "lines",
      key: "id",
      fields: {
        id: "String",
        rate: "Decimal?",
        region: "String",
        at: "DateTime",
        kind: "String",
        amount: "Decimal?",
      },
    },
  },
});

type Row = Record<string, unknown>;
type Refinement = {
  where(filter: Row): Refinement;
  count(): unknown;
};
type IncludeAccessor = {
  create(d: Row): Promise<unknown>;
  include(rel: string, refine?: (r: Refinement) => unknown): { all(): { toArray(): Promise<Row[]> } };
  groupBy(...fields: string[]): {
    aggregate(fn: (agg: { count(): unknown }) => Record<string, unknown>): Promise<Row[]>;
  };
};

const noon = new Date("2024-01-01T12:00:00.000Z");
const evening = new Date("2024-01-01T18:00:00.000Z");

async function withCompoundClient(run: (orm: Record<string, IncludeAccessor>) => Promise<void>): Promise<void> {
  const client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([compoundContract]),
    dbName: `decimal-compound-${crypto.randomUUID()}`,
  });
  try {
    const orm = client.orm as unknown as Record<string, IncludeAccessor>;
    await orm["ledgers"]!.create({ id: "g1", rate: "1", region: "eu", at: noon, name: "G1" });
    await orm["ledgers"]!.create({ id: "g2", rate: "2", region: "us", at: evening, name: "G2" });
    // A String position holds Decimal-looking text: "1" and "1.0" differ there.
    await orm["ledgers"]!.create({ id: "g3", rate: "4", region: "1", at: noon, name: "G3" });
    const lines: Row[] = [
      // Match g1 by (rate, region) and by (rate, at); the spellings differ from the parent's.
      { id: "l1", rate: "1.00", region: "eu", at: new Date(noon), kind: "a", amount: "10" },
      { id: "l2", rate: "1e0", region: "eu", at: new Date(noon), kind: "b", amount: "10.0" },
      // Same Decimal, other String: crosses g1's rate with g2's region.
      { id: "l3", rate: "1", region: "us", at: new Date(evening), kind: "a", amount: "1e1" },
      // Same String, other Decimal.
      { id: "l4", rate: "3", region: "eu", at: new Date(noon), kind: "a", amount: null },
      // Matches g2 by (rate, region) and (rate, at).
      { id: "l5", rate: "2.0", region: "us", at: new Date(evening), kind: "a", amount: null },
      // No rate at all.
      { id: "l6", rate: null, region: "eu", at: new Date(noon), kind: "a", amount: null },
      // Equal rate, but the String position differs only as text.
      { id: "l7", rate: "4.0", region: "1.0", at: new Date(noon), kind: "a", amount: null },
      { id: "l8", rate: "4.0", region: "1", at: new Date(noon), kind: "a", amount: null },
    ];
    for (const line of lines) await orm["lines"]!.create(line);
    const bookings: Row[] = [
      { id: "b1", rate: "1.00", region: "eu" },
      { id: "b2", rate: "2e0", region: "us" },
      { id: "b3", rate: null, region: "eu" },
    ];
    for (const booking of bookings) await orm["bookings"]!.create(booking);
    await run(orm);
  } finally {
    await client.close();
  }
}

const idsOf = (value: unknown): string[] =>
  (value as Row[]).map((row) => row["id"] as string).sort((a, b) => a.localeCompare(b));

describe("Decimal in compound joins", () => {
  it("matches a Decimal and a String position independently", async () => {
    await withCompoundClient(async (orm) => {
      const ledgers = await orm["ledgers"]!.include("byRegion").all().toArray();
      const byId = Object.fromEntries(ledgers.map((ledger) => [ledger["id"], idsOf(ledger["byRegion"])]));
      // l3 shares g1's rate and g2's region, so it belongs to neither.
      expect(byId).toEqual({ g1: ["l1", "l2"], g2: ["l5"], g3: ["l8"] });
    });
  });

  it("matches a Decimal and a DateTime position independently", async () => {
    await withCompoundClient(async (orm) => {
      const ledgers = await orm["ledgers"]!.include("byTime").all().toArray();
      const byId = Object.fromEntries(ledgers.map((ledger) => [ledger["id"], idsOf(ledger["byTime"])]));
      expect(byId).toEqual({ g1: ["l1", "l2"], g2: ["l5"], g3: ["l7", "l8"] });
    });
  });

  it("attaches the parent for a to-one compound join, and null when the Decimal is missing", async () => {
    await withCompoundClient(async (orm) => {
      const bookings = await orm["bookings"]!.include("ledger").all().toArray();
      const parentOf = Object.fromEntries(
        bookings.map((booking) => [booking["id"], (booking["ledger"] as Row | null)?.["id"] ?? null])
      );
      expect(parentOf).toEqual({ b1: "g1", b2: "g2", b3: null });
    });
  });

  it("counts a to-many relation by numeric identity", async () => {
    await withCompoundClient(async (orm) => {
      const ledgers = await orm["ledgers"]!.include("byRegion", (r) => r.count())
        .all()
        .toArray();
      expect(Object.fromEntries(ledgers.map((ledger) => [ledger["id"], ledger["byRegion"]]))).toEqual({
        g1: 2,
        g2: 1,
        g3: 1,
      });
    });
  });

  it("counts a refined to-many relation by numeric identity", async () => {
    await withCompoundClient(async (orm) => {
      const ledgers = await orm["ledgers"]!.include("byRegion", (r) => r.where({ kind: "a" }).count())
        .all()
        .toArray();
      expect(Object.fromEntries(ledgers.map((ledger) => [ledger["id"], ledger["byRegion"]]))).toEqual({
        g1: 1,
        g2: 1,
        g3: 1,
      });
    });
  });

  it("applies a refined where, including one on a Decimal field, to numerically joined rows", async () => {
    await withCompoundClient(async (orm) => {
      const byKind = await orm["ledgers"]!.include("byRegion", (r) => r.where({ kind: "b" }))
        .all()
        .toArray();
      expect(Object.fromEntries(byKind.map((ledger) => [ledger["id"], idsOf(ledger["byRegion"])]))).toEqual({
        g1: ["l2"],
        g2: [],
        g3: [],
      });
      const byAmount = await orm["ledgers"]!.include("byRegion", (r) => r.where({ amount: "10" }))
        .all()
        .toArray();
      expect(Object.fromEntries(byAmount.map((ledger) => [ledger["id"], idsOf(ledger["byRegion"])]))).toEqual({
        g1: ["l1", "l2"],
        g2: [],
        g3: [],
      });
    });
  });
});

describe("Decimal in groupBy", () => {
  it("groups a Decimal together with a non-Decimal field", async () => {
    await withCompoundClient(async (orm) => {
      const groups = await orm["lines"]!.groupBy("rate", "region").aggregate((agg) => ({ count: agg.count() }));
      // (1, eu) holds l1 and l2; every other (rate, region) pair holds one line.
      expect(groups).toEqual([
        { rate: "1.00", region: "eu", count: 2 },
        { rate: "1", region: "us", count: 1 },
        { rate: "3", region: "eu", count: 1 },
        { rate: "2.0", region: "us", count: 1 },
        { rate: null, region: "eu", count: 1 },
        { rate: "4.0", region: "1.0", count: 1 },
        { rate: "4.0", region: "1", count: 1 },
      ]);
    });
  });

  it("keeps a null Decimal in its own group, apart from zero", async () => {
    await withCompoundClient(async (orm) => {
      await orm["lines"]!.create({ id: "z1", rate: "0", region: "eu", at: noon, kind: "a", amount: "0.00" });
      await orm["lines"]!.create({ id: "z2", rate: "-0.0", region: "eu", at: noon, kind: "a", amount: null });
      const groups = await orm["lines"]!.groupBy("amount").aggregate((agg) => ({ count: agg.count() }));
      expect(groups).toEqual([
        { amount: "10", count: 3 },
        { amount: null, count: 6 },
        { amount: "0.00", count: 1 },
      ]);
      const byRate = await orm["lines"]!.groupBy("rate").aggregate((agg) => ({ count: agg.count() }));
      expect(byRate.find((group) => group["rate"] === null)).toEqual({ rate: null, count: 1 });
      expect(byRate.find((group) => group["rate"] === "0")).toEqual({ rate: "0", count: 2 });
    });
  });
});
