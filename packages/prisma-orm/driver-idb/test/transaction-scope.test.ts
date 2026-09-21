/**
 * IdbTransactionScope tests.
 *
 * Tests `createTransactionScope` and `IdbTransactionScope` against
 * fake-indexeddb. Each describe block opens a fresh database.
 *
 * Coverage:
 *   execute (put)      — single-store write, row echoed back
 *   execute (key-get)  — read inside scope sees pre-seeded rows
 *   multi-store        — writes to two stores in one transaction
 *   commit             — tx.oncomplete resolves after all writes
 *   rollback           — tx.abort rolls back uncommitted writes
 *   rollback idempotent — calling rollback twice doesn't throw
 *   unknown store      — execute with unknown storeName rejects with IdbExecuteError
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdbExecuteError } from "../src/core/execute/error";
import { createTransactionScope } from "../src/core/transaction-scope";
import type { IdbKeyGetPlan, IdbPutPlan } from "../src/core/plan-body";

// ── Helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;
function dbName(): string {
  return `tx-scope-test-${++dbCounter}`;
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

function seedStore(db: IDBDatabase, storeName: string, records: Record<string, unknown>[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

const USERS: StoreSpec = { name: "users", keyPath: "id" };
const POSTS: StoreSpec = { name: "posts", keyPath: "id" };

// ── execute (put) ─────────────────────────────────────────────────────────────

describe("execute put", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS]);
  });
  afterEach(() => db.close());

  it("writes the record and echoes it back", async () => {
    const scope = createTransactionScope(db, ["users"]);
    const plan: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } };
    const rows = await scope.execute(plan);
    await scope.commit();
    expect(rows).toEqual([{ id: "u1", name: "Alice" }]);
    const all = await getAllRows(db, "users");
    expect(all).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it("multiple puts in one scope are all written", async () => {
    const scope = createTransactionScope(db, ["users"]);
    const p1: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } };
    const p2: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u2", name: "Bob" } };
    await scope.execute(p1);
    await scope.execute(p2);
    await scope.commit();
    const all = await getAllRows(db, "users");
    expect(all.map((r) => r["id"]).sort()).toEqual(["u1", "u2"]);
  });
});

// ── execute (key-get) ─────────────────────────────────────────────────────────

describe("execute key-get", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS]);
    await seedStore(db, "users", [{ id: "u1", name: "Alice" }]);
  });
  afterEach(() => db.close());

  it("reads a pre-existing row inside the scope", async () => {
    const scope = createTransactionScope(db, ["users"], "readonly");
    const plan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u1" };
    const rows = await scope.execute(plan);
    await scope.commit();
    expect(rows).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it("returns empty array for missing key", async () => {
    const scope = createTransactionScope(db, ["users"], "readonly");
    const plan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "nope" };
    const rows = await scope.execute(plan);
    await scope.commit();
    expect(rows).toHaveLength(0);
  });
});

// ── multi-store ───────────────────────────────────────────────────────────────

describe("multi-store write", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS, POSTS]);
  });
  afterEach(() => db.close());

  it("writes to two stores in a single transaction", async () => {
    const scope = createTransactionScope(db, ["users", "posts"]);
    const user: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } };
    const post: IdbPutPlan = {
      meta: META,
      kind: "put",
      storeName: "posts",
      record: { id: "p1", authorId: "u1", title: "Hi" },
    };
    await scope.execute(user);
    await scope.execute(post);
    await scope.commit();
    expect(await getAllRows(db, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    expect(await getAllRows(db, "posts")).toEqual([{ id: "p1", authorId: "u1", title: "Hi" }]);
  });
});

// ── rollback ──────────────────────────────────────────────────────────────────

describe("rollback", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS, POSTS]);
  });
  afterEach(() => db.close());

  it("aborts the transaction — no rows written", async () => {
    const scope = createTransactionScope(db, ["users", "posts"]);
    const user: IdbPutPlan = { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } };
    await scope.execute(user);
    scope.rollback();
    // commit() rejects because the transaction was aborted
    await expect(scope.commit()).rejects.toThrow();
    expect(await getAllRows(db, "users")).toHaveLength(0);
  });

  it("rollback is idempotent — second call does not throw", async () => {
    const scope = createTransactionScope(db, ["users"]);
    scope.rollback();
    // Second rollback should not throw
    expect(() => scope.rollback()).not.toThrow();
  });
});

// ── unknown store ─────────────────────────────────────────────────────────────

describe("unknown store", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS]);
  });
  afterEach(() => db.close());

  it("execute rejects with IdbExecuteError STORE_NOT_FOUND", async () => {
    const scope = createTransactionScope(db, ["users"]);
    const plan: IdbPutPlan = { meta: META, kind: "put", storeName: "nonexistent", record: { id: "x1" } };
    await expect(scope.execute(plan)).rejects.toBeInstanceOf(IdbExecuteError);
  });
});
