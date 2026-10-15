/** Nullable predicates through the ORM, indexed candidates, and cursor residual filtering. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import {
  andExpr,
  fieldFilter as f,
  notExpr,
  nullCheckExpr,
  orExpr,
  type IdbFilterExpr,
  type IdbQueryPlan,
} from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbOrm, type IdbQueryExecutor, type IdbStoreAccessor } from "../src/exports/orm";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", bio: "String?", score: "Int" },
      indexes: { byScore: { keyPath: "score" }, byBio: { keyPath: "bio" } },
    },
  },
});

/** Record the chosen access path while executing the real driver plan. */
class TestExecutor implements IdbQueryExecutor {
  readonly plans: IdbQueryPlan[] = [];
  constructor(readonly driver: IdbRuntimeDriverInstance) {}

  /** Execute the same lowered plan that production queries use. */
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    this.plans.push(plan);
    const rows = this.driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of rows) yield row as Row;
      })()
    );
  }
}

let counter = 0;

/** Include both explicit null and an absent field, which older stored rows may contain. */
function seed(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("users", { keyPath: "id" });
      store.createIndex("byScore", "score");
      store.createIndex("byBio", "bio");
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("users", "readwrite");
      for (const row of [
        { id: "u1", bio: null, score: 1 },
        { id: "u2", score: 2 },
        { id: "u3", bio: "x", score: 3 },
        { id: "u4", bio: "y", score: 4 },
      ])
        tx.objectStore("users").put(row);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

const cases: Array<[string, IdbFilterExpr, string[]]> = [
  ["neq", f("bio", "neq", "x"), ["u4"]],
  ["notIn", f("bio", "notIn", ["x"]), ["u4"]],
  ["not equality", notExpr(f("bio", "eq", "x")), ["u4"]],
  ["double not", notExpr(notExpr(f("bio", "eq", "x"))), ["u3"]],
  ["not ordering", notExpr(f("bio", "gt", "x")), ["u3"]],
  ["not string match", notExpr(f("bio", "contains", "x")), ["u4"]],
  ["not AND unknown and true", notExpr(andExpr([f("bio", "eq", "x"), f("score", "gt", 0)])), ["u4"]],
  ["not AND unknown and false", notExpr(andExpr([f("bio", "eq", "x"), f("score", "lt", 0)])), ["u1", "u2", "u3", "u4"]],
  ["not OR unknown and false", notExpr(orExpr([f("bio", "eq", "x"), f("score", "lt", 0)])), ["u4"]],
  ["OR explicitly admits null", orExpr([f("bio", "neq", "x"), nullCheckExpr("bio", true)]), ["u1", "u2", "u4"]],
  ["eq null", f("bio", "eq", null), ["u1", "u2"]],
  ["neq null", f("bio", "neq", null), ["u3", "u4"]],
  ["isNull", nullCheckExpr("bio", true), ["u1", "u2"]],
  ["isNotNull", nullCheckExpr("bio", false), ["u3", "u4"]],
  ["not eq null", notExpr(f("bio", "eq", null)), ["u3", "u4"]],
  ["not neq null", notExpr(f("bio", "neq", null)), ["u1", "u2"]],
  ["in mixed null", f("bio", "in", ["x", null]), ["u3"]],
  ["notIn mixed null", f("bio", "notIn", ["x", null]), []],
  ["not in mixed null", notExpr(f("bio", "in", ["x", null])), []],
  ["not notIn mixed null", notExpr(f("bio", "notIn", ["x", null])), ["u3"]],
  ["in null only", f("bio", "in", [null]), []],
  ["notIn null only", f("bio", "notIn", [null]), []],
  ["in empty", f("bio", "in", []), []],
  ["notIn empty", f("bio", "notIn", []), ["u1", "u2", "u3", "u4"]],
];

describe("nullable SQL predicates", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;
  let users: IdbStoreAccessor<never, never>;

  beforeEach(async () => {
    const name = `nullable-filters-${++counter}`;
    await seed(name);
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
    users = (idbOrm({ contract, executor }) as unknown as Record<string, IdbStoreAccessor<never, never>>)["users"]!;
  });
  afterEach(() => driver.close());

  it.each(cases)("%s matches SQL through reads and counts", async (_name, expr, expected) => {
    for (const predicate of [expr, andExpr([f("score", "gte", 0), expr])]) {
      const query = users.where(() => predicate);
      const rows = (await query.all().toArray()) as Array<{ id: string }>;
      expect(rows.map((row) => row.id).sort()).toEqual(expected);
      expect(await query.count()).toBe(expected.length);
    }
  });

  describe.each([false, true])("indexed residuals (cursor: %s)", (cursor) => {
    it.each([
      ["neq", f("bio", "neq", "x"), ["u4"]],
      ["notIn", f("bio", "notIn", ["x"]), ["u4"]],
      ["notIn with null", f("bio", "notIn", ["x", null]), []],
      ["in with null", f("bio", "in", ["x", null]), ["u3"]],
    ] satisfies Array<[string, IdbFilterExpr, string[]]>)(
      "applies %s before pagination",
      async (_name, expr, expected) => {
        let query = users.where((m) => andExpr([m["score"]!.gte(0), expr]));
        if (cursor) query = query.take(1);
        const rows = (await query.all().toArray()) as Array<{ id: string }>;
        expect(rows.map((row) => row.id)).toEqual(expected);
        expect(executor.plans[0]?.idbPlan).toMatchObject({
          kind: cursor ? "cursor-scan" : "get-all",
          indexName: "byScore",
        });
      }
    );
  });

  it("applies null-aware residuals after a primary-key lookup", async () => {
    const rows = await users
      .where((m) => andExpr([m["id"]!.eq("u1"), m["bio"]!.neq("x")]))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    expect(executor.plans[0]?.idbPlan.kind).toBe("key-get");
  });
});
