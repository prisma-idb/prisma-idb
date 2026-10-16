import { afterEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import {
  fieldFilter,
  andExpr,
  orExpr,
  notExpr,
  type IdbQueryPlan,
  type IdbFilterOp,
} from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import { idbOrm, type IdbQueryExecutorWithTransaction, type IdbStoreAccessor } from "../src/exports/orm";

const databases: IDBDatabase[] = [];
let counter = 0;

/** Build the real client over string storage, with optional Decimal indexes. */
async function setup(indexed: boolean, values: (string | null)[] = ["9", "10", "100", "2.5"], includePeers = false) {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Item: {
        store: "items",
        key: "id",
        fields: { id: "String", price: "Decimal?", label: "String", category: "String" },
        ...(includePeers
          ? {
              relations: {
                peers: { to: "Item", cardinality: "1:N" as const, on: { local: ["category"], target: ["category"] } },
              },
            }
          : {}),
        indexes: indexed
          ? {
              byPrice: { keyPath: "price", unique: false },
              byCategory: { keyPath: "category", unique: false },
              byCategoryPrice: { keyPath: ["category", "price"], unique: false },
            }
          : {},
      },
    },
  });
  const name = `decimal-queries-${++counter}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("items", { keyPath: "id" });
      if (indexed) {
        store.createIndex("byPrice", "price");
        store.createIndex("byCategory", "category");
        store.createIndex("byCategoryPrice", ["category", "price"]);
      }
      values.forEach((price, i) => store.put({ id: String(i), price, label: price ?? "null", category: "a" }));
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  databases.push(db);
  const driver = createIDBRuntimeDriver(name).create();
  const executor: IdbQueryExecutorWithTransaction = {
    transaction: (stores: string[], mode?: IDBTransactionMode) => driver.transaction(stores, mode),
    query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
      return new AsyncIterableResult(
        (async function* () {
          for await (const row of driver.execute(plan.idbPlan)) yield row as Row;
        })()
      );
    },
  };
  const orm = idbOrm({ contract, executor }) as unknown as Record<string, IdbStoreAccessor<never, never>>;
  return orm["items"]!;
}

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe.each([false, true])("Decimal queries (indexed: %s)", (indexed) => {
  it("compares ranges and sorts numerically before pagination", async () => {
    const items = await setup(indexed);
    const rows = await items
      .where(() => fieldFilter("price", "gt", "9"))
      .all()
      .toArray();
    expect(rows.map((row) => row["price"]).sort()).toEqual(["10", "100"]);
    const ordered = await items.orderBy({ price: "asc" }).take(2).all().toArray();
    expect(ordered.map((row) => row["price"])).toEqual(["2.5", "9"]);
  });
});

/** Read prices in a deterministic order when the query itself is unordered. */
async function prices(query: IdbStoreAccessor<never, never>): Promise<unknown[]> {
  return (await query.all().toArray()).map((row) => row["price"]);
}

describe.each([false, true])("Decimal predicate regressions (indexed: %s)", (indexed) => {
  it.each([
    ["eq", "1e1", ["10", "10.00", "+0010e0"]],
    ["neq", "10.0", ["-10", "0", "9", "100"]],
    ["in", ["1e1", "-1e1"], ["-10", "10", "10.00", "+0010e0"]],
    ["notIn", ["1e1", "-1e1"], ["0", "9", "100"]],
    ["gt", "10.0", ["100"]],
    ["gte", "10.0", ["10", "10.00", "+0010e0", "100"]],
    ["lt", "0e100", ["-10"]],
    ["lte", "-1e1", ["-10"]],
  ] as const)("uses numeric %s semantics", async (op, value, expected) => {
    const items = await setup(indexed, ["-10", "0", "9", "10", "10.00", "+0010e0", "100"]);
    const filtered = items.where(() => fieldFilter("price", op, value));
    expect((await prices(filtered)).sort()).toEqual([...expected].sort());
    expect(await filtered.count()).toBe(expected.length);
    expect((await filtered.first()) !== null).toBe(expected.length > 0);
  });

  it("intersects numeric bounds and equalities without string contradictions", async () => {
    const items = await setup(indexed, ["9", "10", "10.00", "100"]);
    expect(
      (
        await prices(items.where(() => andExpr([fieldFilter("price", "gte", "9"), fieldFilter("price", "lte", "10")])))
      ).sort()
    ).toEqual(["10", "10.00", "9"]);
    expect(
      (
        await prices(
          items.where(() => andExpr([fieldFilter("price", "eq", "1e1"), fieldFilter("price", "eq", "10.0")]))
        )
      ).sort()
    ).toEqual(["10", "10.00"]);
    expect(
      (
        await prices(items.where(() => orExpr([fieldFilter("price", "eq", "1e1"), fieldFilter("price", "eq", "10.0")])))
      ).sort()
    ).toEqual(["10", "10.00"]);
    expect(await prices(items.where(() => notExpr(fieldFilter("price", "lte", "10.0"))))).toEqual(["100"]);
  });

  it("sorts exact values, reverses direction and paginates after numeric comparisons", async () => {
    const expected = [
      "-1e400",
      "-100",
      "-10",
      "-1e-400",
      "0",
      "1e-400",
      "2.5",
      "9",
      "10",
      "9007199254740992",
      "9007199254740993",
      "1e400",
    ];
    const items = await setup(indexed, [...expected].reverse());
    expect(await prices(items.orderBy({ price: "asc" }))).toEqual(expected);
    expect(await prices(items.orderBy({ price: "desc" }))).toEqual([...expected].reverse());
    expect(await prices(items.orderBy({ price: "asc" }).skip(3).take(4))).toEqual(expected.slice(3, 7));
    expect(await prices(items.orderBy({ price: "desc" }).take(2))).toEqual(["1e400", "9007199254740993"]);
    expect(
      await prices(items.where(() => fieldFilter("price", "gt", "9007199254740992")).orderBy({ price: "asc" }))
    ).toEqual(["9007199254740993", "1e400"]);
  });

  it("keeps precision in fractional ranges and uses safe indexes with residual Decimal filters", async () => {
    const items = await setup(indexed, ["1.000000000000000000002", "1.000000000000000000001", "1.0"]);
    const query = items.where(() =>
      andExpr([fieldFilter("category", "eq", "a"), fieldFilter("price", "gt", "1.000000000000000000001")])
    );
    expect(await prices(query.orderBy({ price: "asc" }).take(1))).toEqual(["1.000000000000000000002"]);
  });

  it("preserves null behavior and uses a secondary field to break numeric ties", async () => {
    const items = await setup(indexed, ["1.00", "1.0", "1", null]);
    expect(await prices(items.orderBy({ price: "asc", label: "asc" }))).toEqual(["1", "1.0", "1.00", null]);
    expect(await prices(items.orderBy({ price: "desc", label: "asc" }))).toEqual([null, "1", "1.0", "1.00"]);
    expect(await prices(items.where(() => fieldFilter("price", "gte", "0")))).toHaveLength(3);
    expect(await prices(items.where({ price: null }))).toEqual([null]);
    expect(await prices(items.where({ price: "1e0" }))).toHaveLength(3);
    expect(await prices(items.where(() => fieldFilter("label", "eq", "1")))).toEqual(["1"]);
  });

  it("uses related-model Decimal metadata for refined include ordering", async () => {
    const items = await setup(indexed, ["9", "10", "100", "2.5"], true);
    const rows = await items
      .include("peers" as never, (peers) =>
        peers
          .where(() => fieldFilter("price", "gt", "9"))
          .orderBy({ price: "desc" })
          .skip(1)
          .take(1)
      )
      .all()
      .toArray();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect((row["peers"] as Record<string, unknown>[]).map((peer) => peer["price"])).toEqual(["10"]);
    }
  });

  it("uses numeric matches for writes and preserves the supplied storage text", async () => {
    const items = await setup(indexed, ["1", "1.00", "2"]);
    await items.where(() => fieldFilter("price", "eq", "1e0")).updateAll({ category: "updated" });
    expect(await items.where({ category: "updated" }).count()).toBe(2);
    await items.where(() => fieldFilter("price", "lt", "2e0")).deleteAll();
    expect(await prices(items)).toEqual(["2"]);
    await items.create({ id: "new", price: "+001.2300E-1", label: "new", category: "a" });
    await expect(items.where({ id: "new" }).updateAll({ price: "NaN" })).rejects.toThrow();
    expect(await prices(items.where({ id: "new" }))).toEqual(["+001.2300E-1"]);
  });

  it.each(["NaN", "Infinity", "1e", " 1", "1\n", ""])("rejects invalid Decimal input %j", async (value) => {
    const items = await setup(indexed, []);
    await expect(items.create({ id: "invalid", price: value, label: "invalid", category: "a" })).rejects.toThrow();
    for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn"] as IdbFilterOp[]) {
      const filter = fieldFilter("price", op, op === "in" || op === "notIn" ? [value] : value);
      await expect(
        items
          .where(() => filter)
          .all()
          .toArray()
      ).rejects.toThrow("Expected finite Decimal text");
      await expect(items.where(() => filter).count()).rejects.toThrow("Expected finite Decimal text");
    }
  });

  it("rejects malformed legacy storage when a numeric comparison encounters it", async () => {
    const items = await setup(indexed, ["broken", "1"]);
    await expect(
      items
        .where(() => fieldFilter("price", "gt", "0"))
        .all()
        .toArray()
    ).rejects.toThrow("Expected finite Decimal text");
    await expect(items.orderBy({ price: "asc" }).all().toArray()).rejects.toThrow("Expected finite Decimal text");
  });
});
