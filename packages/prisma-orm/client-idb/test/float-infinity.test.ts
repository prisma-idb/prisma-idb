/**
 * A Float holds ±Infinity, as upstream's float codecs do, but not NaN. Infinity is a valid
 * IndexedDB key, so indexed and unindexed Float fields must agree on filters, order and
 * aggregates.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { IdbRecordValidationError } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Reading: {
      store: "readings",
      key: "id",
      fields: { id: "String", indexed: "Float", plain: "Float" },
      indexes: { byIndexed: { keyPath: "indexed" } },
    },
    UniqueReading: {
      store: "uniqueReadings",
      key: "id",
      fields: { id: "String", value: "Float" },
      indexes: { byValue: { keyPath: "value", unique: true } },
    },
    Series: { store: "series", key: "id", fields: { id: "String", values: "Float[]" } },
  },
});

type Row = { id: string; indexed: number; plain: number };
type Field = { gt(v: number): unknown; lt(v: number): unknown; eq(v: number): unknown };
type Readings = {
  create(row: Row): Promise<unknown>;
  createAll(rows: Row[]): Promise<unknown>;
  findUnique(id: string): Promise<Row | null>;
  where(filter: (m: Record<string, Field>) => unknown): { all(): { toArray(): Promise<Row[]> } };
  orderBy(order: Record<string, "asc" | "desc">): { all(): { toArray(): Promise<Row[]> } };
  aggregate(spec: (agg: Record<string, (field: string) => unknown>) => unknown): Promise<Record<string, unknown>>;
};

let client: Awaited<ReturnType<typeof createAutoMigratingIdbClient>>;
let readings: Readings;
let dbCounter = 0;

beforeEach(async () => {
  client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `float-infinity-${++dbCounter}`,
  });
  readings = client.orm["readings"] as unknown as Readings;
  await readings.createAll([
    { id: "low", indexed: -Infinity, plain: -Infinity },
    { id: "one", indexed: 1, plain: 1 },
    { id: "high", indexed: Infinity, plain: Infinity },
  ]);
});
afterEach(async () => client.close());

const ids = async (rows: Promise<Row[]>) => (await rows).map((row) => row.id);

describe.each(["indexed", "plain"])("a %s Float holding ±Infinity", (field) => {
  it("stores and reads both infinities", async () => {
    expect(await readings.findUnique("high")).toEqual({ id: "high", indexed: Infinity, plain: Infinity });
    expect(await readings.findUnique("low")).toEqual({ id: "low", indexed: -Infinity, plain: -Infinity });
  });

  it("filters them like any other number", async () => {
    expect(
      await ids(
        readings
          .where((m) => m[field]!.gt(1))
          .all()
          .toArray()
      )
    ).toEqual(["high"]);
    expect(
      await ids(
        readings
          .where((m) => m[field]!.lt(1))
          .all()
          .toArray()
      )
    ).toEqual(["low"]);
    expect(
      await ids(
        readings
          .where((m) => m[field]!.eq(Infinity))
          .all()
          .toArray()
      )
    ).toEqual(["high"]);
  });

  it("sorts -Infinity first and Infinity last", async () => {
    expect(
      await ids(
        readings
          .orderBy({ [field]: "asc" })
          .all()
          .toArray()
      )
    ).toEqual(["low", "one", "high"]);
    expect(
      await ids(
        readings
          .orderBy({ [field]: "desc" })
          .all()
          .toArray()
      )
    ).toEqual(["high", "one", "low"]);
  });

  it("returns NaN for mixed infinities in sum and avg", async () => {
    expect(
      await readings.aggregate((agg) => ({
        min: agg["min"]!(field),
        max: agg["max"]!(field),
        sum: agg["sum"]!(field),
        avg: agg["avg"]!(field),
      }))
    ).toEqual({ min: -Infinity, max: Infinity, sum: NaN, avg: NaN });
  });
});

it("returns positive infinity from sum and avg and still reports finite overflow", async () => {
  await client.close();
  client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `float-infinity-${++dbCounter}`,
  });
  readings = client.orm["readings"] as unknown as Readings;
  await readings.createAll([
    { id: "a", indexed: Number.MAX_VALUE, plain: Number.MAX_VALUE },
    { id: "b", indexed: Infinity, plain: Number.MAX_VALUE },
  ]);
  expect(
    await readings.aggregate((agg) => ({
      sum: agg["sum"]!("indexed"),
      avg: agg["avg"]!("indexed"),
    }))
  ).toEqual({ sum: Infinity, avg: Infinity });
  await expect(readings.aggregate((agg) => ({ sum: agg["sum"]!("plain") }))).rejects.toThrow(/finite number range/);
});

it("rejects a duplicate infinity on a unique Float index", async () => {
  const uniqueReadings = client.orm["uniqueReadings"] as unknown as {
    create(row: { id: string; value: number }): Promise<unknown>;
    findUnique(id: string): Promise<unknown>;
  };
  const first = { id: "first", value: Infinity };
  await uniqueReadings.create(first);
  await expect(uniqueReadings.create({ id: "duplicate", value: Infinity })).rejects.toMatchObject({
    code: "ADD_FAILED",
    cause: { name: "ConstraintError" },
  });
  expect(await uniqueReadings.findUnique("first")).toEqual(first);
  expect(await uniqueReadings.findUnique("duplicate")).toBeNull();
});

it("refuses NaN in a Float", async () => {
  await expect(readings.create({ id: "nan", indexed: NaN, plain: 1 })).rejects.toThrow(IdbRecordValidationError);
  expect(await readings.findUnique("nan")).toBeNull();
});

it("accepts ±Infinity as a list element and refuses NaN there", async () => {
  const series = client.orm["series"] as unknown as {
    create(row: { id: string; values: number[] }): Promise<unknown>;
    findUnique(id: string): Promise<{ values: number[] } | null>;
  };
  await series.create({ id: "s", values: [-Infinity, 1, Infinity] });
  expect(await series.findUnique("s")).toEqual({ id: "s", values: [-Infinity, 1, Infinity] });
  await expect(series.create({ id: "n", values: [1, NaN] })).rejects.toThrow(IdbRecordValidationError);
});

it("accepts ±Infinity in an update and refuses NaN there", async () => {
  const update = (id: string, patch: Partial<Row>) =>
    (readings as unknown as { where(f: object): { update(p: object): Promise<unknown> } }).where({ id }).update(patch);
  await update("one", { indexed: Infinity, plain: -Infinity });
  expect(await readings.findUnique("one")).toEqual({ id: "one", indexed: Infinity, plain: -Infinity });
  await expect(update("one", { plain: NaN })).rejects.toThrow(IdbRecordValidationError);
  expect(await readings.findUnique("one")).toEqual({ id: "one", indexed: Infinity, plain: -Infinity });
});
