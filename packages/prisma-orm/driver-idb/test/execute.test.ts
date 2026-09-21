/**
 * execute() tests.
 *
 * Tests the `executeIdbPlan` dispatcher (src/core/execute/index.ts) and
 * `IdbRuntimeDriverInstance.execute()` (the async-iterable wrapper) against
 * fake-indexeddb, which fully implements the IDB API including cursors,
 * indexes, and transactions.
 *
 * Test strategy:
 * - Each test opens a fresh-named database (via dbName()) to avoid cross-test
 *   state. fake-indexeddb/auto provides a global IDB singleton per test file.
 * - Object stores are created with an in-test helper (openTestDb) because the
 *   driver's upgradeneeded handler is a no-op (migrations are handled by
 *   IdbMigrationRunner).
 * - `executeIdbPlan` is tested directly; `IdbRuntimeDriverInstance.execute()`
 *   gets a smoke test that covers the async-iterable wrapper.
 *
 * Coverage:
 *   key-get     — hit, miss
 *   index-get   — match, empty
 *   cursor-scan — full, filter, skip, take, skip+take, comparator, direction
 *   add         — create-only insert
 *   put         — overwrite
 *   delete      — existing key, non-existent key, key range
 *   batch       — multi-op single-tx, multi-store
 *   errors      — unknown store → IdbExecuteError.STORE_NOT_FOUND
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdbExecuteError } from "../src/core/execute/error";
import { executeIdbPlan } from "../src/core/execute/index";
import { createIDBRuntimeDriver } from "../src/exports/runtime";
import type {
  IdbBatchPlan,
  IdbAddPlan,
  IdbCursorScanPlan,
  IdbDeletePlan,
  IdbIndexGetPlan,
  IdbKeyGetPlan,
  IdbPutPlan,
  IdbScanWritePlan,
  IdbUpdatePlan,
} from "../src/core/plan-body";

// ── Helpers ──────────────────────────────────────────────────────────────────

let dbCounter = 0;
function dbName(): string {
  return `execute-test-${++dbCounter}`;
}

/** Minimal PlanMeta satisfying the required fields. */
const META = { target: "idb", storageHash: "test-hash", lane: "test" } as const;

type StoreIndex = { name: string; keyPath: string; unique?: boolean };
type StoreSpec = { name: string; keyPath: string; indexes?: StoreIndex[] };

/**
 * Open a test database, creating the specified object stores and indexes
 * inside `upgradeneeded`. Returns the opened IDBDatabase.
 */
function openTestDb(name: string, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const storeSpec of stores) {
        const os = db.createObjectStore(storeSpec.name, { keyPath: storeSpec.keyPath });
        for (const idx of storeSpec.indexes ?? []) {
          os.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Seed records into a store using a one-off readwrite transaction. */
function seedStore(db: IDBDatabase, storeName: string, records: Record<string, unknown>[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Shared schema ─────────────────────────────────────────────────────────────

const USERS_STORE: StoreSpec = {
  name: "users",
  keyPath: "id",
  indexes: [{ name: "by-email", keyPath: "email", unique: true }],
};

const POSTS_STORE: StoreSpec = {
  name: "posts",
  keyPath: "id",
  indexes: [{ name: "by-author", keyPath: "authorId" }],
};

type User = { id: string; name: string; email: string; score: number };

const ALICE: User = { id: "u1", name: "Alice", email: "alice@example.com", score: 30 };
const BOB: User = { id: "u2", name: "Bob", email: "bob@example.com", score: 10 };
const CAROL: User = { id: "u3", name: "Carol", email: "carol@example.com", score: 20 };

// ── key-get ───────────────────────────────────────────────────────────────────

describe("key-get", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    await seedStore(db, "users", [ALICE, BOB]);
  });
  afterEach(() => db.close());

  it("returns the matching row when key exists", async () => {
    const plan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u1" };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u1", name: "Alice" });
  });

  it("returns empty array when key is missing", async () => {
    const plan: IdbKeyGetPlan = {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "does-not-exist",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(0);
  });
});

// ── index-get ─────────────────────────────────────────────────────────────────

describe("index-get", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    await seedStore(db, "users", [ALICE, BOB, CAROL]);
  });
  afterEach(() => db.close());

  it("returns matching rows via index range", async () => {
    const plan: IdbIndexGetPlan = {
      meta: META,
      kind: "index-get",
      storeName: "users",
      indexName: "by-email",
      range: IDBKeyRange.only("bob@example.com"),
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u2", name: "Bob" });
  });

  it("returns empty array when no records match", async () => {
    const plan: IdbIndexGetPlan = {
      meta: META,
      kind: "index-get",
      storeName: "users",
      indexName: "by-email",
      range: IDBKeyRange.only("nobody@example.com"),
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(0);
  });
});

// ── cursor-scan ───────────────────────────────────────────────────────────────

describe("cursor-scan", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    // Seed in non-alphabetical order so scan order is IDB primary-key order (u1,u2,u3).
    await seedStore(db, "users", [BOB, CAROL, ALICE]);
  });
  afterEach(() => db.close());

  it("returns all rows when no options are set", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(3);
    // IDB iterates in primary-key (id) order: u1, u2, u3
    expect(rows.map((r) => r["id"])).toEqual(["u1", "u2", "u3"]);
  });

  it("applies a filter and returns only matching rows", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      filter: (row) => (row["score"] as number) >= 20,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(2);
    // Alice (30) and Carol (20), in pk order
    expect(rows.map((r) => r["id"])).toEqual(["u1", "u3"]);
  });

  it("applies skip (OFFSET) and skips the first N rows", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      skip: 1,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r["id"])).toEqual(["u2", "u3"]);
  });

  it("applies take (LIMIT) and returns at most N rows", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      take: 2,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r["id"])).toEqual(["u1", "u2"]);
  });

  it("applies both skip and take for pagination", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      skip: 1,
      take: 1,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u2" });
  });

  it("sorts by comparator (in-memory ORDER BY) before applying skip/take", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      // Sort ascending by score: Bob(10), Carol(20), Alice(30)
      comparator: (a, b) => (a["score"] as number) - (b["score"] as number),
      skip: 1,
      take: 1,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u3", score: 20 }); // Carol
  });

  it("returns rows in reverse primary-key order with direction 'prev'", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      direction: "prev",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows.map((r) => r["id"])).toEqual(["u3", "u2", "u1"]);
  });

  it("applies filter and comparator together", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      filter: (row) => (row["score"] as number) > 10,
      // Sort descending by score
      comparator: (a, b) => (b["score"] as number) - (a["score"] as number),
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(2); // Carol (20) and Alice (30)
    expect(rows.map((r) => r["score"])).toEqual([30, 20]); // Alice first (higher score)
  });

  it("scans via a secondary index when indexName is set", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      indexName: "by-email",
      range: IDBKeyRange.bound("a", "c"), // emails starting with a or b
    };
    const rows = await executeIdbPlan(db, plan);
    // alice@ and bob@ match; carol@ does not (c > c is false, but "carol" >= "c")
    // IDBKeyRange.bound("a","c") includes keys where "a" <= key <= "c"
    // alice@... starts with 'a', bob@... starts with 'b', carol@... > 'c'
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const emails = rows.map((r) => r["email"] as string);
    expect(emails).toContain("alice@example.com");
    expect(emails).toContain("bob@example.com");
  });
});

// ── add ───────────────────────────────────────────────────────────────────────

describe("add", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
  });
  afterEach(() => db.close());

  it("inserts a new record and echoes it back", async () => {
    const plan: IdbAddPlan = {
      meta: META,
      kind: "add",
      storeName: "users",
      record: ALICE,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(ALICE);

    const getRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    });
    expect(getRows[0]).toEqual(ALICE);
  });

  it("rejects when the primary key already exists", async () => {
    await seedStore(db, "users", [ALICE]);
    const duplicate = { ...ALICE, score: 99 };
    const plan: IdbAddPlan = {
      meta: META,
      kind: "add",
      storeName: "users",
      record: duplicate,
    };

    await expect(executeIdbPlan(db, plan)).rejects.toMatchObject({ code: "ADD_FAILED" });

    const getRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    });
    expect(getRows[0]).toEqual(ALICE);
  });
});

// ── put ───────────────────────────────────────────────────────────────────────

describe("put", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
  });
  afterEach(() => db.close());

  it("inserts a new record and echoes it back", async () => {
    const plan: IdbPutPlan = {
      meta: META,
      kind: "put",
      storeName: "users",
      record: ALICE,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(ALICE);

    // Verify the record was actually persisted.
    const getRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    });
    expect(getRows[0]).toEqual(ALICE);
  });

  it("overwrites an existing record and echoes the new version", async () => {
    await seedStore(db, "users", [ALICE]);
    const updated = { ...ALICE, score: 99 };
    const plan: IdbPutPlan = {
      meta: META,
      kind: "put",
      storeName: "users",
      record: updated,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows[0]).toMatchObject({ id: "u1", score: 99 });

    const getRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    });
    expect(getRows[0]).toMatchObject({ score: 99 });
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe("delete", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    await seedStore(db, "users", [ALICE, BOB]);
  });
  afterEach(() => db.close());

  it("deletes an existing record and echoes it", async () => {
    const plan: IdbDeletePlan = {
      meta: META,
      kind: "delete",
      storeName: "users",
      key: "u1",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toEqual([ALICE]);

    // Verify Alice is gone.
    const getRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    });
    expect(getRows).toHaveLength(0);
  });

  it("deletes a non-existent key without error and yields no rows", async () => {
    const plan: IdbDeletePlan = {
      meta: META,
      kind: "delete",
      storeName: "users",
      key: "does-not-exist",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(0);
  });

  it("deletes all records in a key range and echoes them", async () => {
    const plan: IdbDeletePlan = {
      meta: META,
      kind: "delete",
      storeName: "users",
      key: IDBKeyRange.bound("u1", "u2"), // deletes u1 and u2
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toEqual([ALICE, BOB]);

    const allRows = await executeIdbPlan(db, { meta: META, kind: "cursor-scan", storeName: "users" });
    expect(allRows).toHaveLength(0);
  });
});

// ── update ───────────────────────────────────────────────────────────────────

describe("update", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    await seedStore(db, "users", [ALICE]);
  });
  afterEach(() => db.close());

  it("merges patch onto existing record and echoes the result", async () => {
    const plan: IdbUpdatePlan = {
      meta: META,
      kind: "update",
      storeName: "users",
      key: "u1",
      patch: { score: 42, active: false },
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    // Patch fields are applied.
    expect(rows[0]).toMatchObject({ score: 42, active: false });
    // Unpatched fields are preserved from the original record.
    expect(rows[0]).toMatchObject({ id: "u1", email: ALICE["email"] });
  });

  it("persists the merged record to the store", async () => {
    const plan: IdbUpdatePlan = {
      meta: META,
      kind: "update",
      storeName: "users",
      key: "u1",
      patch: { score: 99 },
    };
    await executeIdbPlan(db, plan);
    const getRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    });
    expect(getRows[0]).toMatchObject({ id: "u1", score: 99 });
  });

  it("inserts a record (insert semantics) when key does not exist", async () => {
    const plan: IdbUpdatePlan = {
      meta: META,
      kind: "update",
      storeName: "users",
      key: "u99",
      patch: { id: "u99", email: "ghost@example.com", score: 0 },
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u99", email: "ghost@example.com" });
  });

  it("patch does NOT affect other records in the store", async () => {
    await seedStore(db, "users", [BOB]);
    await executeIdbPlan(db, {
      meta: META,
      kind: "update",
      storeName: "users",
      key: "u1",
      patch: { score: 7 },
    });
    const bobRows = await executeIdbPlan(db, {
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u2",
    });
    // Bob's score is untouched.
    expect(bobRows[0]).toMatchObject({ id: "u2", score: BOB["score"] });
  });
});

// ── batch ─────────────────────────────────────────────────────────────────────

describe("batch", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE, POSTS_STORE]);
    await seedStore(db, "users", [ALICE, BOB]);
  });
  afterEach(() => db.close());

  it("runs multiple ops atomically in a single transaction", async () => {
    const plan: IdbBatchPlan = {
      meta: META,
      kind: "batch",
      storeNames: ["users"],
      ops: [
        { meta: META, kind: "put", storeName: "users", record: CAROL },
        { meta: META, kind: "delete", storeName: "users", key: "u2" },
      ],
    };
    const rows = await executeIdbPlan(db, plan);
    // put echoes the record; delete now echoes the row it removed
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(CAROL);
    expect(rows[1]).toEqual(BOB);

    // Alice and Carol should remain; Bob should be gone.
    const allRows = await executeIdbPlan(db, {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
    });
    const ids = allRows.map((r) => r["id"]);
    expect(ids).toContain("u1");
    expect(ids).toContain("u3");
    expect(ids).not.toContain("u2");
  });

  it("collects read-op rows in op order", async () => {
    const plan: IdbBatchPlan = {
      meta: META,
      kind: "batch",
      storeNames: ["users"],
      ops: [
        { meta: META, kind: "key-get", storeName: "users", key: "u2" }, // Bob
        { meta: META, kind: "key-get", storeName: "users", key: "u1" }, // Alice
      ],
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "u2" }); // Bob first (op order)
    expect(rows[1]).toMatchObject({ id: "u1" }); // Alice second
  });

  it("spans multiple stores within a single transaction", async () => {
    const post = { id: "p1", authorId: "u1", title: "Hello" };
    const plan: IdbBatchPlan = {
      meta: META,
      kind: "batch",
      storeNames: ["users", "posts"],
      ops: [
        { meta: META, kind: "put", storeName: "users", record: CAROL },
        { meta: META, kind: "put", storeName: "posts", record: post },
      ],
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(CAROL);
    expect(rows[1]).toEqual(post);
  });

  it("opens the transaction in readwrite mode for update-only batches", async () => {
    // Regression: `executeBatchPlan` previously checked only for `put`/`delete`
    // when picking the tx mode. A batch containing only `update` ops would
    // open readonly and the inner `store.put(merged)` would abort the tx.
    const plan: IdbBatchPlan = {
      meta: META,
      kind: "batch",
      storeNames: ["users"],
      ops: [{ meta: META, kind: "update", storeName: "users", key: "u1", patch: { score: 99 } }],
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u1", score: 99 });
  });
});

// ── IdbRuntimeDriverInstance.execute() — async-iterable smoke test ────────────

describe("IdbRuntimeDriverInstance.execute()", () => {
  it("yields rows via AsyncIterable wrapper", async () => {
    const name = dbName();
    // We need a db that the driver can use, so we manually open it (driver's
    // upgradeneeded is a no-op). The trick: open the db, create the store, close
    // it, then let the driver open it again at version 1 (no upgrade needed).
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    setupDb.close();

    const driver = createIDBRuntimeDriver(name, 1).create();
    const plan: IdbCursorScanPlan = { meta: META, kind: "cursor-scan", storeName: "users" };

    const collected: Record<string, unknown>[] = [];
    for await (const row of driver.execute(plan)) {
      collected.push(row);
    }

    expect(collected).toHaveLength(2);
    expect(collected.map((r) => r["id"])).toEqual(["u1", "u2"]);

    await driver.close();
  });
});

// ── Error handling ─────────────────────────────────────────────────────────────

describe("error handling", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
  });
  afterEach(() => db.close());

  it("rejects with IdbExecuteError when store does not exist", async () => {
    const plan: IdbKeyGetPlan = {
      meta: META,
      kind: "key-get",
      storeName: "nonexistent-store",
      key: "x",
    };
    await expect(executeIdbPlan(db, plan)).rejects.toBeInstanceOf(IdbExecuteError);
  });

  it("sets code = STORE_NOT_FOUND on missing store error", async () => {
    const plan: IdbKeyGetPlan = {
      meta: META,
      kind: "key-get",
      storeName: "nonexistent-store",
      key: "x",
    };
    const err = await executeIdbPlan(db, plan).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdbExecuteError);
    expect((err as IdbExecuteError).code).toBe("STORE_NOT_FOUND");
    expect((err as IdbExecuteError).planKind).toBe("key-get");
  });

  it("IdbExecuteError has stable name and category", () => {
    const err = new IdbExecuteError({ code: "TRANSACTION_ABORTED", planKind: "cursor-scan" }, "test");
    expect(err.name).toBe("IdbExecuteError");
    expect(err.category).toBe("DRIVER");
    expect(err.severity).toBe("error");
  });
});

// ── scan-write (put-merged) ────────────────────────────────────────────────────

describe("scan-write (put-merged)", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    await seedStore(db, "users", [ALICE, BOB, CAROL]);
  });
  afterEach(() => db.close());

  it("updates the first matching row (take:1) and returns it", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "put-merged",
      patch: { name: "ALICE" },
      filter: (r) => r["id"] === "u1",
      take: 1,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u1", name: "ALICE", email: "alice@example.com" });
  });

  it("preserves untouched fields when merging patch", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "put-merged",
      patch: { score: 99 },
      filter: (r) => r["id"] === "u2",
      take: 1,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows[0]).toMatchObject({ id: "u2", name: "Bob", email: "bob@example.com", score: 99 });
  });

  it("updates all matching rows when take is not set", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "put-merged",
      patch: { score: 0 },
      filter: (r) => (r["score"] as number) < 25,
    };
    const rows = await executeIdbPlan(db, plan);
    // BOB (score 10) and CAROL (score 20) match
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["score"] === 0)).toBe(true);
  });

  it("returns empty array when no rows match", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "put-merged",
      patch: { score: 0 },
      filter: (r) => r["id"] === "nonexistent",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(0);
  });

  it("persists merged rows to the store", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "put-merged",
      patch: { name: "ALICE" },
      filter: (r) => r["id"] === "u1",
    };
    await executeIdbPlan(db, plan);

    // Verify persistence via key-get
    const verify = await executeIdbPlan(db, { meta: META, kind: "key-get", storeName: "users", key: "u1" });
    expect(verify[0]).toMatchObject({ id: "u1", name: "ALICE" });
  });
});

// ── scan-write (delete) ───────────────────────────────────────────────────────

describe("scan-write (delete)", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openTestDb(dbName(), [USERS_STORE]);
    await seedStore(db, "users", [ALICE, BOB, CAROL]);
  });
  afterEach(() => db.close());

  it("returns deleted rows and removes them from the store", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "delete",
      filter: (r) => r["id"] === "u1",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u1", name: "Alice" });

    // Verify removal
    const verify = await executeIdbPlan(db, { meta: META, kind: "key-get", storeName: "users", key: "u1" });
    expect(verify).toHaveLength(0);
  });

  it("deletes all matching rows and returns them", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "delete",
      filter: (r) => (r["score"] as number) < 25,
    };
    const rows = await executeIdbPlan(db, plan);
    // BOB (10) and CAROL (20) match
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r["id"]).sort()).toEqual(["u2", "u3"]);
  });

  it("returns empty array when no rows match", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "delete",
      filter: (r) => r["id"] === "nonexistent",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(0);
  });

  it("stops after take:1 deletion", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "delete",
      take: 1,
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(1);

    // Only one row removed — two remain
    const all = await executeIdbPlan(db, { meta: META, kind: "cursor-scan", storeName: "users" });
    expect(all).toHaveLength(2);
  });

  it("deletes all rows when no filter is set", async () => {
    const plan: IdbScanWritePlan = {
      meta: META,
      kind: "scan-write",
      storeName: "users",
      write: "delete",
    };
    const rows = await executeIdbPlan(db, plan);
    expect(rows).toHaveLength(3);

    const all = await executeIdbPlan(db, { meta: META, kind: "cursor-scan", storeName: "users" });
    expect(all).toHaveLength(0);
  });
});
