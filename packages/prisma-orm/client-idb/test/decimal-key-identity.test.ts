import { afterEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type { IdbAtomicPlan } from "@prisma-idb/driver-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import { idbOrm, type IdbQueryExecutorWithTransaction, type IdbStoreAccessor } from "../src/exports/orm";

const databases: IDBDatabase[] = [];
let counter = 0;

/** Exercise Decimal primary keys and a unique index through the real client and driver. */
async function setup(compound: boolean, compoundUnique = false, decimalPrimary = true) {
  const keyPath = compound ? ["group", "id"] : "id";
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Item: {
        store: "items",
        key: keyPath,
        fields: {
          id: decimalPrimary ? "Decimal" : "String",
          group: "String",
          amount: "Decimal",
          note: "String?",
          bucketId: "String?",
        },
        relations: { bucket: { to: "Bucket", cardinality: "N:1", on: { local: ["bucketId"], target: ["id"] } } },
        indexes: { byAmount: { keyPath: compoundUnique ? ["group", "amount"] : "amount", unique: true } },
      },
      Bucket: {
        store: "buckets",
        key: "id",
        fields: { id: "String" },
        relations: { items: { to: "Item", cardinality: "1:N", on: { local: ["id"], target: ["bucketId"] } } },
      },
    },
  });
  const name = `decimal-key-identity-${++counter}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("items", { keyPath });
      store.createIndex("byAmount", compoundUnique ? ["group", "amount"] : "amount", { unique: true });
      req.result.createObjectStore("buckets", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  databases.push(db);
  const driver = createIDBRuntimeDriver(name).create();
  const plans: IdbQueryPlan<unknown>["idbPlan"][] = [];
  const transactionPlans: IdbAtomicPlan[] = [];
  const executor: IdbQueryExecutorWithTransaction = {
    async transaction(stores: string[], mode?: IDBTransactionMode) {
      const scope = await driver.transaction(stores, mode);
      return {
        commit: () => scope.commit(),
        rollback: () => scope.rollback(),
        execute(plan) {
          transactionPlans.push(plan);
          return scope.execute(plan);
        },
      };
    },
    query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
      plans.push(plan.idbPlan);
      return new AsyncIterableResult(
        (async function* () {
          for await (const row of driver.execute(plan.idbPlan)) yield row as Row;
        })()
      );
    },
  };
  const orm = idbOrm({ contract, executor }) as unknown as Record<string, IdbStoreAccessor<never, never>>;
  return { items: orm["items"]!, buckets: orm["buckets"]!, plans, driver, transactionPlans };
}

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe.each([false, true])("Decimal key identity (compound primary key: %s)", (compound) => {
  const key = (id: string, group = "a") => (compound ? [group, id] : id);
  /** Upsert needs the complete primary key, so a compound key also carries its group. */
  const lookup = (id: string) => (compound ? { group: "a", id } : { id });

  it("resolves numeric aliases, preserves normalization and reads the physical key first", async () => {
    const { items, plans } = await setup(compound);
    await items.create({ id: "10", group: "a", amount: "20" });
    plans.length = 0;
    expect(await items.findUnique(key("1e1"))).toMatchObject({ id: "10", amount: "20", note: null });
    expect(plans[0]).toMatchObject({ kind: "key-get", key: key("1e1") });
    expect(await items.findUnique(key("10"))).toMatchObject({ id: "10" });
    expect(await items.where({ id: "10.00" }).count()).toBe(1);
    if (compound) expect(await items.findUnique(key("10.00", "b"))).toBeNull();
  });

  it("returns null for invalid IndexedDB keys without issuing a plan", async () => {
    const { items, plans } = await setup(compound);
    for (const invalid of [null, undefined, NaN, {}, ["a", undefined]]) {
      expect(await items.findUnique(invalid as never)).toBeNull();
    }
    expect(plans).toEqual([]);
  });

  it("rejects malformed Decimal lookup operands even in an empty store", async () => {
    const { items, plans } = await setup(compound);
    for (const invalid of ["NaN", "", " 10", "Infinity"]) {
      await expect(items.findUnique(key(invalid))).rejects.toThrow("Expected finite Decimal text");
    }
    expect(plans).toEqual([]);
  });

  it("rejects numerically equal primary keys on create and rolls back bulk creates", async () => {
    const { items } = await setup(compound);
    await items.create({ id: "0", group: "a", amount: "10" });
    await expect(items.create({ id: "-0.00e9", group: "a", amount: "20" })).rejects.toMatchObject({
      code: "ADD_FAILED",
    });
    await expect(
      items
        .createAll([
          { id: "1", group: "a", amount: "20" },
          { id: "1.00", group: "a", amount: "30" },
        ])
        .toArray()
    ).rejects.toMatchObject({ code: "ADD_FAILED" });
    expect(await items.count()).toBe(1);
    if (compound) await items.create({ id: "0.00", group: "b", amount: "40" });
  });

  it.each([false, true])(
    "enforces numeric unique indexes on create/update/bulk/upsert (compound index: %s)",
    async (compoundUnique) => {
      const { items } = await setup(compound, compoundUnique);
      await items.create({ id: "1", group: "a", amount: "10" });
      await items.create({ id: "2", group: "a", amount: "20" });
      await expect(items.create({ id: "3", group: "a", amount: "1e1" })).rejects.toMatchObject({ code: "ADD_FAILED" });
      await expect(items.where({ id: "2.0" }).update({ amount: "10.00" })).rejects.toMatchObject({
        code: "PUT_FAILED",
      });
      await expect(items.updateAll({ amount: "30" }).toArray()).rejects.toMatchObject({ code: "PUT_FAILED" });
      await expect(
        items.upsert({
          where: lookup("2.00"),
          create: { id: "3", group: "a", amount: "40" },
          update: { amount: "10.000" },
        })
      ).rejects.toMatchObject({ code: "PUT_FAILED" });
      expect(await items.findUnique(key("2"))).toMatchObject({ amount: "20" });
      expect(await items.findUnique(key("1"))).toMatchObject({ amount: "10" });
      if (compoundUnique) await items.create({ id: "3", group: "b", amount: "1e1" });
    }
  );

  it("updates, upserts and deletes by numeric identity while retaining an equal primary-key patch", async () => {
    const { items } = await setup(compound);
    await items.create({ id: "10", group: "a", amount: "20" });
    expect(await items.where({ id: "10.00" }).update({ id: "1e1", note: "updated" })).toMatchObject({
      id: "10",
      note: "updated",
    });
    expect(
      await items.upsert({
        where: lookup("1e1"),
        create: { id: "30", group: "a", amount: "40" },
        update: { id: "10.0", note: "upserted" },
      })
    ).toMatchObject({ id: "10", note: "upserted" });
    expect(await items.count()).toBe(1);
    await items.delete(key("10.000"));
    expect(await items.count()).toBe(0);
  });

  it.each(["primary", "unique"])("rolls back nested %s collisions together with the parent", async (source) => {
    const { items, buckets } = await setup(compound);
    await expect(
      buckets.create({
        id: "bucket",
        items: (rel: { create(data: unknown): unknown }) =>
          rel.create([
            { id: "1", group: "a", amount: "10" },
            { id: source === "primary" ? "1.00" : "2", group: "a", amount: source === "primary" ? "20" : "10.00" },
          ]),
      } as never)
    ).rejects.toMatchObject({ code: "ADD_FAILED" });
    expect(await items.count()).toBe(0);
    expect(await buckets.count()).toBe(0);
  });

  it("rejects primary-key update collisions and nested update collisions atomically", async () => {
    const { items, buckets } = await setup(compound);
    await items.create({ id: "1", group: "a", amount: "10" });
    await items.create({ id: "2", group: "a", amount: "20" });
    await expect(items.where({ id: "2.0" }).update({ id: "1.00" })).rejects.toMatchObject({ code: "PUT_FAILED" });
    await expect(
      items.where({ id: "2.00" }).update({
        amount: "1e1",
        bucket: (rel: { create(data: unknown): unknown }) => rel.create({ id: "bucket" }),
      } as never)
    ).rejects.toMatchObject({ code: "PUT_FAILED" });
    expect(await buckets.count()).toBe(0);
    expect(await items.findUnique(key("2"))).toMatchObject({ amount: "20", bucketId: null });
  });

  it("serializes concurrent creates that use equivalent Decimal keys", async () => {
    const { items } = await setup(compound);
    const outcomes = await Promise.allSettled([
      items.create({ id: "10", group: "a", amount: "20" }),
      items.create({ id: "1e1", group: "a", amount: "30" }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await items.count()).toBe(1);
  });

  it("reports ambiguous legacy aliases even on an exact primary-key hit", async () => {
    const { items, driver } = await setup(compound);
    const scope = await driver.transaction(["items"], "readwrite");
    for (const [id, amount] of [
      ["10", "20"],
      ["10.00", "30"],
    ])
      await scope.execute({ kind: "add", storeName: "items", record: { id, group: "a", amount } } as never);
    await scope.commit();
    for (const id of ["10", "10.0"])
      await expect(items.findUnique(key(id))).rejects.toMatchObject({ code: "DECIMAL_IDENTITY_CONFLICT" });
    await expect(items.delete(key("1e1"))).rejects.toMatchObject({ code: "DECIMAL_IDENTITY_CONFLICT" });
    expect(await items.count()).toBe(2);
  });
});

describe.each([false, true])("Decimal bulk scan budget (Decimal primary key: %s)", (decimalPrimary) => {
  it("checks unselected rows and rolls back collisions created earlier in the bulk write", async () => {
    const { items } = await setup(false, false, decimalPrimary);
    await items
      .createAll([
        { id: "1", group: "a", amount: "10" },
        { id: "2", group: "a", amount: "20" },
        { id: "3", group: "b", amount: "30" },
      ])
      .toArray();
    await expect(items.where({ group: "a" }).updateAll({ amount: "3e1" }).toArray()).rejects.toMatchObject({
      code: "PUT_FAILED",
    });
    await expect(items.where({ group: "a" }).updateAll({ amount: "40" }).toArray()).rejects.toMatchObject({
      code: "PUT_FAILED",
    });
    expect(await items.where({ amount: "10" }).count()).toBe(1);
    expect(await items.where({ amount: "20" }).count()).toBe(1);
    expect(await items.where({ amount: "30" }).count()).toBe(1);
  });

  it.each(["update", "delete"] as const)("bounds store scans for a bulk %s", async (operation) => {
    const { items, transactionPlans } = await setup(false, false, decimalPrimary);
    await items
      .createAll([
        { id: "1", group: "a", amount: "10" },
        { id: "2", group: "a", amount: "20" },
        { id: "3", group: "b", amount: "30" },
        { id: "4", group: "b", amount: "40" },
      ])
      .toArray();
    transactionPlans.length = 0;
    const selected = items.where({ group: "a" });
    const result = await (
      operation === "update" ? selected.updateAll({ note: "changed" }) : selected.deleteAll()
    ).toArray();
    expect(result).toHaveLength(2);
    expect(transactionPlans.filter((plan) => plan.kind === "cursor-scan").length).toBeLessThanOrEqual(2);
    expect(await items.count()).toBe(operation === "delete" ? 2 : 4);
    if (operation === "update") expect(await items.where({ note: "changed" }).count()).toBe(2);
  });
});
