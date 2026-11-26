/**
 * An `@@ignore` model without `@id` or `@@id` keeps its rows in a store whose
 * keys IndexedDB generates out of line. Foreign-key checks and referential
 * actions reach those rows through their foreign-key indexes and address each
 * one by the key the cursor reports, since the record holds no key field.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbStorage } from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { idbOrm, runOrmTransaction } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

class TestExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  readonly #driver: IdbRuntimeDriverInstance;
  constructor(driver: IdbRuntimeDriverInstance) {
    this.#driver = driver;
  }
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const it = this.#driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of it) yield row as Row;
      })()
    );
  }
  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.#driver.transaction(storeNames, mode);
  }
}

/** Opens a database with every store and index of `contract`, keyless stores included. */
function openDb(name: string, contract: Contract<IdbStorage>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [storeName, store] of Object.entries(contract.storage.stores)) {
        const created = request.result.createObjectStore(storeName, {
          ...(store.keyPath !== undefined ? { keyPath: store.keyPath as string } : {}),
          ...(store.autoIncrement !== undefined ? { autoIncrement: store.autoIncrement } : {}),
        });
        for (const [indexName, index] of Object.entries(store.indexes ?? {})) {
          created.createIndex(indexName, index.keyPath as string, { unique: index.unique ?? false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Every row of a store with its primary key, in key order. */
function entries(db: IDBDatabase, storeName: string): Promise<[IDBValidKey, unknown][]> {
  return new Promise((resolve, reject) => {
    const store = db.transaction([storeName], "readonly").objectStore(storeName);
    const keys = store.getAllKeys();
    const values = store.getAll();
    values.onsuccess = () => resolve(keys.result.map((key, i) => [key, values.result[i]]));
    values.onerror = () => reject(values.error);
  });
}

function addRows(db: IDBDatabase, storeName: string, rows: Record<string, unknown>[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    for (const row of rows) tx.objectStore(storeName).add(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String" },
      indexes: { slug: { keyPath: "slug", unique: true } },
      relations: {
        loose: { to: "Loose", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
        nullable: { to: "Nullable", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
        bySlug: { to: "BySlug", cardinality: "1:N", on: { local: ["slug"], target: ["slug"] } },
        tags: { to: "Tag", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
        restricted: { to: "Restricted", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
        nodes: { to: "Node", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
      },
    },
    // No key: the store generates out-of-line keys.
    Loose: {
      store: "loose",
      fields: { userId: "String", note: "String" },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "cascade" },
      },
      ignored: true,
    },
    Nullable: {
      store: "nullable",
      fields: { userId: "String?", note: "String" },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "setNull" },
      },
      ignored: true,
    },
    BySlug: {
      store: "bySlug",
      fields: { slug: "String" },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["slug"], target: ["slug"] }, onUpdate: "cascade" },
      },
      ignored: true,
    },
    // Keyless, but with a unique code that a visible model references.
    Tag: {
      store: "tags",
      fields: { code: "String", userId: "String" },
      indexes: { code: { keyPath: "code", unique: true } },
      relations: {
        items: { to: "Item", cardinality: "1:N", on: { local: ["code"], target: ["tagCode"] } },
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "cascade" },
      },
      ignored: true,
    },
    Item: {
      store: "items",
      key: "id",
      fields: { id: "String", tagCode: "String" },
      relations: {
        tag: { to: "Tag", cardinality: "N:1", on: { local: ["tagCode"], target: ["code"] } },
      },
    },
    // Keyless, with a self-relation that cascades deletes from parent to child rows.
    Node: {
      store: "nodes",
      fields: { code: "String", parentCode: "String?", userId: "String?" },
      indexes: { code: { keyPath: "code", unique: true } },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "cascade" },
        parent: {
          to: "Node",
          cardinality: "N:1",
          on: { local: ["parentCode"], target: ["code"] },
          onDelete: "cascade",
        },
        children: { to: "Node", cardinality: "1:N", on: { local: ["code"], target: ["parentCode"] } },
      },
      ignored: true,
    },
    // A separate parent, because setDefault checks that its default exists on every delete.
    Owner: {
      store: "owners",
      key: "id",
      fields: { id: "String" },
      relations: {
        defaulted: { to: "Defaulted", cardinality: "1:N", on: { local: ["id"], target: ["ownerId"] } },
      },
    },
    Defaulted: {
      store: "defaulted",
      fields: { ownerId: "String", note: "String" },
      fieldDefaults: { ownerId: "anon" },
      relations: {
        owner: { to: "Owner", cardinality: "N:1", on: { local: ["ownerId"], target: ["id"] }, onDelete: "setDefault" },
      },
      ignored: true,
    },
    Restricted: {
      store: "restricted",
      fields: { userId: "String" },
      relations: { user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } } },
      ignored: true,
    },
  },
});

type Accessor = {
  create(data: Record<string, unknown>): Promise<unknown>;
  delete(key: unknown): Promise<unknown>;
  where(filter: Record<string, unknown>): {
    update(patch: Record<string, unknown>): Promise<unknown>;
    updateAll(patch: Record<string, unknown>): PromiseLike<unknown>;
    deleteAll(): Promise<unknown>;
  };
};

let counter = 0;

describe("@@ignore model without a primary key", () => {
  let db: IDBDatabase;
  let executor: TestExecutor;
  let orm: Record<string, Accessor | undefined>;

  beforeEach(async () => {
    const name = `keyless-ignored-${++counter}`;
    db = await openDb(name, contract);
    executor = new TestExecutor(createIDBRuntimeDriver(name).create());
    orm = idbOrm({ contract, executor }) as unknown as Record<string, Accessor | undefined>;
  });
  afterEach(() => db.close());

  it("stores its rows under generated out-of-line keys and has no accessor", () => {
    expect(contract.storage.stores["loose"]).toMatchObject({ autoIncrement: true });
    expect(contract.storage.stores["loose"]).not.toHaveProperty("keyPath");
    expect(orm["loose"]).toBeUndefined();
  });

  it("cascades a delete into its rows, one by one", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await orm["users"]!.create({ id: "u2", slug: "b" });
    await addRows(db, "loose", [
      { userId: "u1", note: "x" },
      { userId: "u2", note: "y" },
      { userId: "u1", note: "z" },
    ]);
    await orm["users"]!.delete("u1");
    expect(await entries(db, "loose")).toEqual([[2, { userId: "u2", note: "y" }]]);
  });

  it("cascades deleteAll() into its rows", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await orm["users"]!.create({ id: "u2", slug: "b" });
    await addRows(db, "loose", [
      { userId: "u1", note: "x" },
      { userId: "u2", note: "y" },
    ]);
    await orm["users"]!.where({ slug: "a" }).deleteAll();
    expect(await entries(db, "loose")).toEqual([[2, { userId: "u2", note: "y" }]]);
  });

  it("sets its foreign key to null on delete and keeps each row's key", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await addRows(db, "nullable", [
      { userId: "u1", note: "x" },
      { userId: "u1", note: "y" },
    ]);
    await orm["users"]!.delete("u1");
    expect(await entries(db, "nullable")).toEqual([
      [1, { userId: null, note: "x" }],
      [2, { userId: null, note: "y" }],
    ]);
  });

  it("cascades an update of the field its foreign-key index walks, keeping each row's key", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await addRows(db, "bySlug", [{ slug: "a" }, { slug: "other" }, { slug: "a" }]);
    await orm["users"]!.where({ id: "u1" }).update({ slug: "b" });
    expect(await entries(db, "bySlug")).toEqual([
      [1, { slug: "b" }],
      [2, { slug: "other" }],
      [3, { slug: "b" }],
    ]);
  });

  it("cascades updateAll() of the field its foreign-key index walks, keeping each row's key", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await orm["users"]!.create({ id: "u2", slug: "other" });
    await addRows(db, "bySlug", [{ slug: "a" }, { slug: "other" }, { slug: "a" }]);
    await orm["users"]!.where({ id: "u1" }).updateAll({ slug: "b" });
    expect(await entries(db, "bySlug")).toEqual([
      [1, { slug: "b" }],
      [2, { slug: "other" }],
      [3, { slug: "b" }],
    ]);
  });

  it("cascades a delete through its own self-relation", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await addRows(db, "nodes", [
      { code: "root", parentCode: null, userId: "u1" },
      { code: "other", parentCode: null, userId: null },
      { code: "kid", parentCode: "root", userId: null },
      { code: "grandkid", parentCode: "kid", userId: null },
      { code: "sibling", parentCode: "other", userId: null },
    ]);
    await orm["users"]!.delete("u1");
    expect(await entries(db, "nodes")).toEqual([
      [2, { code: "other", parentCode: null, userId: null }],
      [5, { code: "sibling", parentCode: "other", userId: null }],
    ]);
  });

  it("sets its foreign key to the field's default on delete and keeps each row's key", async () => {
    for (const id of ["anon", "o1", "o2"]) await orm["owners"]!.create({ id });
    await addRows(db, "defaulted", [
      { ownerId: "o1", note: "x" },
      { ownerId: "o2", note: "y" },
      { ownerId: "o1", note: "z" },
    ]);
    await orm["owners"]!.delete("o1");
    expect(await entries(db, "defaulted")).toEqual([
      [1, { ownerId: "anon", note: "x" }],
      [2, { ownerId: "o2", note: "y" }],
      [3, { ownerId: "anon", note: "z" }],
    ]);
  });

  it("cascades into its rows inside an explicit transaction", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await orm["users"]!.create({ id: "u2", slug: "b" });
    await addRows(db, "loose", [
      { userId: "u1", note: "x" },
      { userId: "u2", note: "y" },
    ]);
    await addRows(db, "nodes", [
      { code: "root", parentCode: null, userId: "u1" },
      { code: "kid", parentCode: "root", userId: null },
    ]);
    await runOrmTransaction({ contract, executor }, ["users"], async (tx) => {
      await (tx as unknown as Record<string, Accessor>)["users"]!.delete("u1");
    });
    expect(await entries(db, "loose")).toEqual([[2, { userId: "u2", note: "y" }]]);
    expect(await entries(db, "nodes")).toEqual([]);
  });

  it("restricts a delete while its rows reference the parent", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await addRows(db, "restricted", [{ userId: "u1" }]);
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete User.*child records.*restricted/i);
    expect(await entries(db, "restricted")).toEqual([[1, { userId: "u1" }]]);
  });

  it("checks a foreign key that references its unique field", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await addRows(db, "tags", [{ code: "red", userId: "u1" }]);
    await expect(orm["items"]!.create({ id: "i1", tagCode: "blue" })).rejects.toThrow(/FK violation on relation 'tag'/);
    await orm["items"]!.create({ id: "i1", tagCode: "red" });
  });

  it("runs the actions of its own child relations before a cascade deletes it", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await addRows(db, "tags", [{ code: "red", userId: "u1" }]);
    await orm["items"]!.create({ id: "i1", tagCode: "red" });
    // Item.tag restricts, so the cascade from User into Tag stops.
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete Tag '1'.*child records.*items/i);
    expect(await entries(db, "tags")).toEqual([[1, { code: "red", userId: "u1" }]]);
  });

  it("enforces its unique index", async () => {
    await orm["users"]!.create({ id: "u1", slug: "a" });
    await expect(
      addRows(db, "tags", [
        { code: "red", userId: "u1" },
        { code: "red", userId: "u1" },
      ])
    ).rejects.toThrow();
    expect(await entries(db, "tags")).toEqual([]);
  });
});
