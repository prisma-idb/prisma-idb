/**
 * Driver tests.
 *
 * What we test here:
 * - createIDBRuntimeDriver produces a descriptor with correct identity
 * - descriptor.create() returns an IdbRuntimeDriverInstance
 * - instance.db resolves to an IDBDatabase
 * - Multiple awaits of instance.db return the same object (shared Promise)
 * - close() resolves without error
 * - Two descriptors for different db names each open their own database
 *
 * IdbPlanBody structural checks are type-level only (compile-time); they
 * don't produce runtime assertions.
 *
 * Isolation strategy: fake-indexeddb/auto provides a global `indexedDB`
 * singleton. Tests use unique db names (via dbName()) to avoid cross-test
 * state. Each instance is closed in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdbRuntimeDriverInstance } from "../src/core/idb-driver";
import type {
  IdbAtomicPlan,
  IdbBatchPlan,
  IdbCursorScanPlan,
  IdbDeletePlan,
  IdbIndexGetPlan,
  IdbKeyGetPlan,
  IdbPlanBody,
  IdbPutPlan,
} from "../src/core/plan-body";
import { createIDBRuntimeDriver } from "../src/exports/runtime";

// ── Helpers ──────────────────────────────────────────────────────────────────

let dbCounter = 0;
function dbName(): string {
  return `driver-test-${++dbCounter}`;
}

// ── createIDBRuntimeDriver ────────────────────────────────────────────────────

describe("createIDBRuntimeDriver", () => {
  it("returns a descriptor with correct family / target identity", () => {
    const descriptor = createIDBRuntimeDriver(dbName());
    expect(descriptor.kind).toBe("driver");
    expect(descriptor.familyId).toBe("idb");
    expect(descriptor.targetId).toBe("idb");
  });

  it("descriptor.create() returns an IdbRuntimeDriverInstance", () => {
    const descriptor = createIDBRuntimeDriver(dbName());
    const instance = descriptor.create();
    expect(instance).toBeInstanceOf(IdbRuntimeDriverInstance);
    expect(instance.familyId).toBe("idb");
    expect(instance.targetId).toBe("idb");
    void instance.close();
  });

  it("two calls with different db names produce independent instances", () => {
    const a = createIDBRuntimeDriver(dbName()).create();
    const b = createIDBRuntimeDriver(dbName()).create();
    expect(a.db).not.toBe(b.db);
    void a.close();
    void b.close();
  });
});

// ── IdbRuntimeDriverInstance.db ──────────────────────────────────────────────

describe("IdbRuntimeDriverInstance.db", () => {
  let instance: IdbRuntimeDriverInstance;

  beforeEach(() => {
    instance = createIDBRuntimeDriver(dbName()).create();
  });

  afterEach(async () => {
    await instance.close();
  });

  it("resolves to an IDBDatabase", async () => {
    const db = await instance.db;
    expect(db).toBeDefined();
    // Check the IDB interface shape rather than instanceof (fake-indexeddb
    // uses its own class which may differ from the DOM type declaration).
    expect(typeof db.close).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.createObjectStore).toBe("function");
  });

  it("multiple awaits return the same database object", async () => {
    const [a, b, c] = await Promise.all([instance.db, instance.db, instance.db]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("database opens at version 1 by default", async () => {
    const db = await instance.db;
    expect(db.version).toBe(1);
  });

  it("respects a custom version argument", async () => {
    const versioned = createIDBRuntimeDriver(dbName(), 3).create();
    const db = await versioned.db;
    expect(db.version).toBe(3);
    await versioned.close();
  });
});

// ── IdbRuntimeDriverInstance.close ───────────────────────────────────────────

describe("IdbRuntimeDriverInstance.close", () => {
  it("resolves without error after the db is open", async () => {
    const instance = createIDBRuntimeDriver(dbName()).create();
    await instance.db; // ensure open before closing
    await expect(instance.close()).resolves.toBeUndefined();
  });

  it("can be called before the db Promise resolves", async () => {
    // close() awaits db internally, so this exercises the race.
    const instance = createIDBRuntimeDriver(dbName()).create();
    await expect(instance.close()).resolves.toBeUndefined();
  });
});

// ── IdbPlanBody type-level structural checks ──────────────────────────────────
//
// These are compile-time-only assertions: if the types are structurally wrong
// the file won't compile. They don't produce runtime assertions.

// Minimal valid PlanMeta required by ExecutionPlan
const meta = {
  target: "idb",
  storageHash: "test-hash",
  lane: "read",
} as const;

// cursor-scan
const _cursorScan = {
  meta,
  kind: "cursor-scan",
  storeName: "users",
} satisfies IdbCursorScanPlan;

// key-get
const _keyGet = {
  meta,
  kind: "key-get",
  storeName: "users",
  key: "abc-123",
} satisfies IdbKeyGetPlan;

// index-get
const _indexGet = {
  meta,
  kind: "index-get",
  storeName: "users",
  indexName: "by-email",
  range: IDBKeyRange.only("user@example.com"),
} satisfies IdbIndexGetPlan;

// put
const _put = {
  meta,
  kind: "put",
  storeName: "users",
  record: { id: "abc-123", name: "Alice" },
} satisfies IdbPutPlan;

// delete
const _delete = {
  meta,
  kind: "delete",
  storeName: "users",
  key: "abc-123",
} satisfies IdbDeletePlan;

// batch
const _batch = {
  meta,
  kind: "batch",
  storeNames: ["users", "posts"],
  ops: [_put, _delete] satisfies ReadonlyArray<IdbAtomicPlan>,
} satisfies IdbBatchPlan;

// union assignability
const _plans: IdbPlanBody[] = [_cursorScan, _keyGet, _indexGet, _put, _delete, _batch];
void _plans; // suppress noUnusedLocals
