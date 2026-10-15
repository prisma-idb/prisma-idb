import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm, type IdbQueryExecutor, type IdbQueryExecutorWithTransaction } from "../src/exports/orm";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Member: {
      store: "members",
      key: ["orgId", "id"],
      fields: {
        orgId: "String",
        id: "String",
        name: "String",
        email: "String?",
        code: "String?",
        tags: "Json",
      },
      indexes: {
        byName: { keyPath: "name", unique: false },
        byEmail: { keyPath: "email", unique: true },
        byOrgCode: { keyPath: ["orgId", "code"], unique: true },
        byTag: { keyPath: "tags", unique: true, multiEntry: true },
      },
    },
  },
});

/** Execute against real IndexedDB transactions so lookup/write atomicity is exercised. */
class TestExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  constructor(readonly driver: IdbRuntimeDriverInstance) {}

  /** Forward row plans without replacing the driver's native key comparison. */
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const rows = this.driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of rows) yield row as Row;
      })()
    );
  }

  /** Keep the lookup and mutation on the same driver transaction. */
  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.driver.transaction(storeNames, mode);
  }
}

let counter = 0;

/** Create the native indexes declared by the contract, including nullable unique indexes. */
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("members", { keyPath: ["orgId", "id"] });
      store.createIndex("byName", "name");
      store.createIndex("byEmail", "email", { unique: true });
      store.createIndex("byOrgCode", ["orgId", "code"], { unique: true });
      store.createIndex("byTag", "tags", { unique: true, multiEntry: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const existing = { orgId: "o1", id: "m1", name: "shared", email: "one@example.com", code: "one", tags: [] };
const other = { orgId: "o1", id: "m2", name: "shared", email: null, code: null, tags: [] };
const create = { orgId: "o1", id: "new", name: "created", email: "new@example.com", code: "new", tags: [] };

describe("upsert unique lookup validation", () => {
  let db: IDBDatabase;
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;
  let members: ReturnType<typeof idbOrm<typeof contract>>["members"];

  beforeEach(async () => {
    const name = `upsert-unique-${++counter}`;
    db = await openDatabase(name);
    driver = createIDBRuntimeDriver(name).create();
    executor = new TestExecutor(driver);
    members = idbOrm({ contract, executor })["members"]!;
    await members.createAll([existing, other, { ...other, id: "m3" }]);
  });

  afterEach(async () => {
    await driver.close();
    db.close();
  });

  it.each([
    ["empty", {}],
    ["missing filter", undefined],
    ["null filter", null],
    ["ambiguous nonunique index", { name: "shared" }],
    ["unmatched nonunique index", { name: "missing" }],
    ["single current match on nonunique index", { name: "shared", id: "m1" }],
    ["incomplete primary key", { orgId: "o1" }],
    ["undefined primary key member", { orgId: "o1", id: undefined }],
    ["incomplete unique index", { code: "one" }],
    ["null unique key", { email: null }],
    ["undefined unique key", { email: undefined }],
    ["null compound unique member", { orgId: "o1", code: null }],
    ["empty multi-entry unique key", { tags: [] }],
    ["nonempty multi-entry unique key", { tags: ["new"] }],
    ["invalid IndexedDB key", { email: { equals: "one@example.com" } }],
    ["NaN key", { email: NaN }],
    ["invalid date key", { email: new Date(NaN) }],
    ["inherited unique key", Object.create({ email: "one@example.com" })],
    ["non-enumerable unique key", Object.defineProperty({}, "email", { value: "one@example.com" })],
  ])("rejects %s before opening a transaction or changing rows", async (_name, where) => {
    const before = await members.all().toArray();
    const transaction = vi.spyOn(executor, "transaction");
    const query = vi.spyOn(executor, "query");
    await expect(members.upsert({ where: where as never, create, update: { name: "updated" } })).rejects.toThrow(
      /upsert.*complete primary key or unique index/i
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(await members.all().toArray()).toEqual(before);
  });

  it.each([
    ["compound primary key", { orgId: "o1", id: "m1" }, { orgId: "o1", id: "new" }],
    ["nullable unique index", { email: "one@example.com" }, { email: "new@example.com" }],
    ["compound unique index", { orgId: "o1", code: "one" }, { orgId: "o1", code: "new" }],
  ])("uses a complete %s on both branches", async (_name, found, missing) => {
    expect(await members.upsert({ where: found, create, update: { name: "updated" } })).toEqual({
      ...existing,
      name: "updated",
    });
    expect(await members.upsert({ where: missing, create, update: { name: "unused" } })).toEqual(create);
    expect(await members.findUnique(["o1", "m1"])).toEqual({ ...existing, name: "updated" });
    expect(await members.findUnique(["o1", "new"])).toEqual(create);
    expect(await members.count()).toBe(4);
  });

  it("keeps additional equality predicates when a unique key is complete", async () => {
    // The extra predicate excludes the existing unique row, selecting the create branch.
    expect(
      await members.upsert({ where: { email: existing.email, name: "missing" }, create, update: { name: "unused" } })
    ).toEqual(create);
    expect(await members.findUnique(["o1", "m1"])).toEqual(existing);
  });

  it("accepts a complete primary key even when an extra nullable filter is null", async () => {
    expect(
      await members.upsert({ where: { orgId: "o1", id: "m2", email: null }, create, update: { name: "updated" } })
    ).toEqual({ ...other, name: "updated" });
  });

  it("serializes concurrent unique lookups with their writes", async () => {
    const args = { where: { email: create.email }, create, update: { name: "updated" } };
    const rows = await Promise.all([members.upsert(args), members.upsert(args)]);
    expect(rows.map((row) => row["name"])).toEqual(["created", "updated"]);
    expect(await members.count()).toBe(4);
    expect(await members.findUnique(["o1", "new"])).toEqual({ ...create, name: "updated" });
  });
});
