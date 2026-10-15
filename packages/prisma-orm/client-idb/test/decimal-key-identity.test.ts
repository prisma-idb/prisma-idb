import { afterEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import { idbOrm, type IdbQueryExecutorWithTransaction, type IdbStoreAccessor } from "../src/exports/orm";

const databases: IDBDatabase[] = [];
let counter = 0;

/** Exercise Decimal primary keys and a unique index through the real client and driver. */
async function setup(compound: boolean) {
  const keyPath = compound ? ["group", "id"] : "id";
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Item: {
        store: "items",
        key: keyPath,
        fields: { id: "Decimal", group: "String", amount: "Decimal", note: "String?" },
        indexes: { byAmount: { keyPath: "amount", unique: true } },
      },
    },
  });
  const name = `decimal-key-identity-${++counter}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("items", { keyPath });
      store.createIndex("byAmount", "amount", { unique: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  databases.push(db);
  const driver = createIDBRuntimeDriver(name).create();
  const plans: IdbQueryPlan<unknown>["idbPlan"][] = [];
  const executor: IdbQueryExecutorWithTransaction = {
    transaction: (stores: string[], mode?: IDBTransactionMode) => driver.transaction(stores, mode),
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
  return { items: orm["items"]!, plans };
}

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe.each([false, true])("Decimal key identity (compound primary key: %s)", (compound) => {
  it("uses exact key gets while where equality remains numeric", async () => {
    const { items, plans } = await setup(compound);
    const key = (id: string) => (compound ? ["a", id] : id);
    await items.create({ id: "0", group: "a", amount: "10" });
    plans.length = 0;

    expect(await items.findUnique(key("0.0"))).toBeNull();
    expect(await items.findUnique(key("0"))).toMatchObject({ id: "0", amount: "10", note: null });
    expect(plans).toEqual([
      expect.objectContaining({ kind: "key-get", key: key("0.0") }),
      expect.objectContaining({ kind: "key-get", key: key("0") }),
    ]);

    await items.create({ id: "0.00", group: "a", amount: "20" });
    expect(await items.findUnique(key("0.00"))).toMatchObject({ id: "0.00", amount: "20" });
    expect(await items.findUnique(key("0.0"))).toBeNull();
    expect(await items.where({ id: "0e1" }).count()).toBe(2);
    await expect(items.create({ id: "0", group: "a", amount: "30" })).rejects.toMatchObject({ code: "ADD_FAILED" });
  });

  it("enforces unique Decimal strings without merging numerically equal spellings", async () => {
    const { items } = await setup(compound);
    await items.create({ id: "1", group: "a", amount: "10" });
    await items.create({ id: "2", group: "a", amount: "10.00" });
    expect(await items.where({ amount: "1e1" }).count()).toBe(2);
    await expect(items.create({ id: "3", group: "a", amount: "10" })).rejects.toMatchObject({ code: "ADD_FAILED" });
    expect(await items.count()).toBe(2);
  });
});
