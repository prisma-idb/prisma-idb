/**
 * withMutationScope tests (client-idb).
 *
 * Tests `withMutationScope` and `IdbQueryExecutorWithTransaction` against
 * fake-indexeddb via `IdbRuntimeDriverInstance`.
 *
 * Coverage:
 *   commit on success  — both stores written, results returned
 *   rollback on error  — neither store written, error rethrown
 *   nested scopes      — two sequential scopes are independent
 *   empty storeNames   — withMutationScope rejects (IDB won't open empty-scope tx)
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { withMutationScope } from "../src/core/mutation-scope";
import type { IdbQueryExecutorWithTransaction } from "../src/core/mutation-scope";
import type { IdbQueryExecutor } from "../src/core/executor";
import type { IdbPutPlan, IdbKeyGetPlan } from "@prisma-idb/driver-idb/runtime";

// ── Helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;
function dbName(): string {
  return `mutation-scope-test-${++dbCounter}`;
}

const META = { target: "idb", storageHash: "test", lane: "test" } as const;

type StoreSpec = { name: string; keyPath: string };

function openTestDb(name: string, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of stores) db.createObjectStore(s.name, { keyPath: s.keyPath });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllRows(db: IDBDatabase, storeName: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Minimal executor that wraps `IdbRuntimeDriverInstance` and also exposes
 * `transaction()` — satisfies `IdbQueryExecutorWithTransaction`.
 */
class TestExecutorWithTransaction implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  readonly #driver: IdbRuntimeDriverInstance;

  constructor(driver: IdbRuntimeDriverInstance) {
    this.#driver = driver;
  }

  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const iterable = this.#driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of iterable) yield row as Row;
      })()
    );
  }

  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.#driver.transaction(storeNames, mode);
  }
}

const USERS: StoreSpec = { name: "users", keyPath: "id" };
const POSTS: StoreSpec = { name: "posts", keyPath: "id" };

// ── commit on success ─────────────────────────────────────────────────────────

describe("commit on success", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = dbName();
    db = await openTestDb(name, [USERS, POSTS]);
    const driver = createIDBRuntimeDriver(name).create();
    executor = new TestExecutorWithTransaction(driver);
  });
  afterEach(() => db.close());

  it("writes to two stores and returns callback result", async () => {
    const result = await withMutationScope(executor, ["users", "posts"], async (scope) => {
      const userPlan: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } };
      const postPlan: IdbPutPlan = {
        meta: META,
        kind: "put",
        storeName: "posts",
        record: { id: "p1", authorId: "u1", title: "Hi" },
      };
      await scope.execute(userPlan);
      await scope.execute(postPlan);
      return "done";
    });

    expect(result).toBe("done");
    expect(await getAllRows(db, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    expect(await getAllRows(db, "posts")).toEqual([{ id: "p1", authorId: "u1", title: "Hi" }]);
  });

  it("read inside scope sees pre-seeded data", async () => {
    const tx = db.transaction(["users"], "readwrite");
    tx.objectStore("users").put({ id: "u1", name: "Existing" });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });

    const found = await withMutationScope(executor, ["users"], async (scope) => {
      const plan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u1" };
      const rows = await scope.execute(plan);
      return rows[0] ?? null;
    });
    expect(found).toMatchObject({ id: "u1", name: "Existing" });
  });
});

// ── rollback on error ─────────────────────────────────────────────────────────

describe("rollback on error", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = dbName();
    db = await openTestDb(name, [USERS, POSTS]);
    const driver = createIDBRuntimeDriver(name).create();
    executor = new TestExecutorWithTransaction(driver);
  });
  afterEach(() => db.close());

  it("rolls back writes when callback throws — error is rethrown", async () => {
    await expect(
      withMutationScope(executor, ["users", "posts"], async (scope) => {
        const plan: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u2", name: "Bob" } };
        await scope.execute(plan);
        throw new Error("callback failure");
      })
    ).rejects.toThrow("callback failure");

    expect(await getAllRows(db, "users")).toHaveLength(0);
  });
});

// ── sequential scopes ─────────────────────────────────────────────────────────

describe("sequential scopes", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = dbName();
    db = await openTestDb(name, [USERS]);
    const driver = createIDBRuntimeDriver(name).create();
    executor = new TestExecutorWithTransaction(driver);
  });
  afterEach(() => db.close());

  it("second scope runs after first commits", async () => {
    await withMutationScope(executor, ["users"], async (scope) => {
      await scope.execute({ meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } });
    });

    await withMutationScope(executor, ["users"], async (scope) => {
      await scope.execute({ meta: META, kind: "put", storeName: "users", record: { id: "u2", name: "Bob" } });
    });

    const all = await getAllRows(db, "users");
    expect(all.map((r) => r["id"]).sort()).toEqual(["u1", "u2"]);
  });
});
