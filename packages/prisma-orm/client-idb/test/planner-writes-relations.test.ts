import { expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { evaluateFilter, fieldFilter, type IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbOrm, type IdbQueryExecutor, type IdbRelationMutator, type IdbOrmClient } from "../src/exports/orm";

type Action = "cascade" | "setNull" | "setDefault" | "restrict";
type Row = Record<string, unknown>;

function makeContract(action: Action) {
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Parent: {
        store: "parents",
        key: "id",
        fields: { id: "String", code: "String", name: "String" },
        indexes: { byCode: { keyPath: "code", unique: true } },
        relations: {
          children: {
            to: "Child",
            cardinality: "1:N",
            on: { local: ["code"], target: ["parentCode"] },
            onDelete: action,
            onUpdate: action,
          },
        },
      },
      Child: {
        store: "children",
        key: "id",
        fields: { id: "String", parentCode: "String?", name: "String" },
        indexes: { byParent: { keyPath: "parentCode" } },
        fieldDefaults: { parentCode: "b" },
        relations: {
          parent: {
            to: "Parent",
            cardinality: "N:1",
            on: { local: ["parentCode"], target: ["code"] },
          },
        },
      },
    },
  });
}

class TestExecutor implements IdbQueryExecutor {
  constructor(readonly driver: IdbRuntimeDriverInstance) {}
  query<R>(plan: IdbQueryPlan<R>): AsyncIterableResult<R> {
    const iterable = this.driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of iterable) yield row as R;
      })()
    );
  }
  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.driver.transaction(storeNames, mode);
  }
}

const parents = [
  { id: "p1", code: "a", name: "First" },
  { id: "p2", code: "b", name: "Second" },
];
const children = [
  { id: "c1", parentCode: "a", name: "One" },
  { id: "c2", parentCode: "a", name: "Two" },
  { id: "c3", parentCode: "b", name: "Three" },
  { id: "c4", parentCode: null, name: "Four" },
];
let dbCounter = 0;

async function withDatabase(
  action: Action,
  run: (orm: IdbOrmClient<ReturnType<typeof makeContract>>, db: IDBDatabase) => Promise<void>
) {
  const contract = makeContract(action);
  const name = `planner-write-relations-${++dbCounter}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [storeName, definition] of Object.entries(contract.storage.stores)) {
        const store = request.result.createObjectStore(storeName, { keyPath: definition.keyPath as string | string[] });
        for (const [name, index] of Object.entries(definition.indexes ?? {}))
          store.createIndex(name, index.keyPath as string | string[], { unique: index.unique });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const driver = createIDBRuntimeDriver(name).create();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["parents", "children"], "readwrite");
      for (const row of parents) tx.objectStore("parents").put(row);
      for (const row of children) tx.objectStore("children").put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await run(idbOrm({ contract, executor: new TestExecutor(driver) }), db);
  } finally {
    db.close();
    await driver.close();
    indexedDB.deleteDatabase(name);
  }
}

function contents(db: IDBDatabase, store: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as Row[]);
    request.onerror = () => reject(request.error);
  });
}

it("nested connect and disconnect match full filtering when they change the walked foreign-key index", async () => {
  await withDatabase("cascade", async (orm, db) => {
    type Rel = IdbRelationMutator<ReturnType<typeof makeContract>, string>;
    let expected: Row[] = children;
    const apply = (value: unknown, matches: (row: Row) => boolean) => {
      expected = expected.map((row) => (matches(row) ? { ...row, parentCode: value } : row));
    };
    await orm["parents"]!.where({ code: "b" }).update({ children: (rel: Rel) => rel.connect({ parentCode: "a" }) });
    apply("b", (row) => evaluateFilter(fieldFilter("parentCode", "eq", "a"), row));
    expect(await contents(db, "children")).toEqual(expected);
    await orm["parents"]!.where({ code: "b" }).update({
      children: (rel: Rel) => rel.disconnect([{ id: "c1" }, { id: "c3" }, { id: "c4" }]),
    });
    apply(null, (row) => row["parentCode"] === "b" && ["c1", "c3", "c4"].includes(row["id"] as string));
    expect(await contents(db, "children")).toEqual(expected);
    await orm["parents"]!.where({ code: "b" }).update({ children: (rel: Rel) => rel.disconnect() });
    apply(null, (row) => row["parentCode"] === "b");
    expect(await contents(db, "children")).toEqual(expected);
    await orm["children"]!.where({ id: "c4" }).update({ parent: (rel: Rel) => rel.connect({ code: "b" }) });
    apply("b", (row) => row["id"] === "c4");
    expect(await contents(db, "children")).toEqual(expected);
    expect(await contents(db, "parents")).toEqual(parents);
  });
});

for (const action of ["cascade", "setNull", "setDefault", "restrict"] as const) {
  it(`indexed delete ${action} sees all children and matches full filtering`, async () => {
    await withDatabase(action, async (orm, db) => {
      const deletion = orm["parents"]!.where({ code: "a" }).deleteCount();
      if (action === "restrict") {
        await expect(deletion).rejects.toThrow("child records exist");
        expect(await contents(db, "parents")).toEqual(parents);
        expect(await contents(db, "children")).toEqual(children);
        return;
      }
      expect(await deletion).toBe(1);
      const expected = children.flatMap((row) => {
        if (!evaluateFilter(fieldFilter("parentCode", "eq", "a"), row)) return [row];
        return action === "cascade" ? [] : [{ ...row, parentCode: action === "setNull" ? null : "b" }];
      });
      expect(await contents(db, "children")).toEqual(expected);
      expect(await contents(db, "parents")).toEqual([parents[1]]);
    });
  });

  it(`indexed update ${action} sees all children and matches full filtering`, async () => {
    await withDatabase(action, async (orm, db) => {
      const update = orm["parents"]!.where({ code: "a" }).update({ code: "z" });
      if (action === "restrict") {
        await expect(update).rejects.toThrow("would orphan child records");
        expect(await contents(db, "parents")).toEqual(parents);
        expect(await contents(db, "children")).toEqual(children);
        return;
      }
      expect(await update).toEqual({ ...parents[0], code: "z" });
      const expected = children.map((row) =>
        evaluateFilter(fieldFilter("parentCode", "eq", "a"), row)
          ? { ...row, parentCode: action === "cascade" ? "z" : action === "setNull" ? null : "b" }
          : row
      );
      expect(await contents(db, "children")).toEqual(expected);
      expect(await contents(db, "parents")).toEqual([{ ...parents[0], code: "z" }, parents[1]]);
    });
  });
}
