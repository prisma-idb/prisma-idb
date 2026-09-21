/**
 * mutation-executor unit tests.
 *
 * Exercises the IDB mutation executor against fake-indexeddb:
 *   hasNestedMutationCallbacks — detection only on relation fields
 *   executeNestedCreateMutation — 1:N and N:1 nested creates
 *   executeNestedCreateMutation — N:1 nested connect
 *   executeNestedUpdateMutation — N:1 connect + disconnect, 1:N disconnect
 *   atomicity — rollback when nested write fails
 *   scalar FK validation — create/update with FK fields validated against target store
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction, IdbRelationMutator } from "../src/exports/orm";
import {
  executeNestedCreateMutation,
  executeNestedUpdateMutation,
  hasNestedMutationCallbacks,
  hasScalarFkFields,
} from "../src/core/mutation-executor";

// ── Test contract ─────────────────────────────────────────────────────────────

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String" },
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
      },
    },
  },
});

/** Relation mutator type for the test contract — annotates `(rel: RelMutator) =>` callbacks. */
type RelMutator = IdbRelationMutator<typeof contract, string>;

// ── Test executor ─────────────────────────────────────────────────────────────

class TestExecutorWithTransaction implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
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

// ── DB helpers ────────────────────────────────────────────────────────────────

let dbCounter = 0;
function nextDbName(): string {
  return `mutation-executor-test-${++dbCounter}`;
}

function openTestDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("users", { keyPath: "id" });
      db.createObjectStore("posts", { keyPath: "id" });
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

// ── hasNestedMutationCallbacks ────────────────────────────────────────────────

describe("hasNestedMutationCallbacks", () => {
  it("returns true when a relation field holds a function", () => {
    expect(
      hasNestedMutationCallbacks(contract, "User", {
        id: "u1",
        name: "Alice",
        posts: (rel: { create: () => unknown }) => rel.create(),
      })
    ).toBe(true);
  });

  it("returns false when no relation fields are functions", () => {
    expect(
      hasNestedMutationCallbacks(contract, "User", {
        id: "u1",
        name: "Alice",
      })
    ).toBe(false);
  });

  it("returns false when a non-relation field is a function", () => {
    expect(
      hasNestedMutationCallbacks(contract, "User", {
        id: "u1",
        name: () => "Alice",
      })
    ).toBe(false);
  });

  it("returns false for a model with no relations", () => {
    const noRelContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Widget: { store: "widgets", key: "id", fields: { id: "String" } },
      },
    });
    expect(hasNestedMutationCallbacks(noRelContract, "Widget", { fn: () => "x" })).toBe(false);
  });
});

// ── executeNestedCreateMutation — 1:N child-owned ─────────────────────────────

describe("executeNestedCreateMutation — 1:N child create", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("creates parent and children in one transaction", async () => {
    const row = await executeNestedCreateMutation({
      executor,
      contract,
      modelName: "User",
      data: {
        id: "u1",
        name: "Alice",
        posts: (rel: RelMutator) =>
          rel.create([
            { id: "p1", authorId: "placeholder", title: "Post 1" },
            { id: "p2", authorId: "placeholder", title: "Post 2" },
          ]),
      } as Record<string, unknown>,
    });

    expect(row).toMatchObject({ id: "u1", name: "Alice" });

    const users = await getAllRows(db, "users");
    const posts = await getAllRows(db, "posts");
    expect(users).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p["authorId"] === "u1")).toBe(true);
  });

  it("injects parent FK into children, overwriting any supplied value", async () => {
    await executeNestedCreateMutation({
      executor,
      contract,
      modelName: "User",
      data: {
        id: "u1",
        name: "Alice",
        posts: (rel: RelMutator) => rel.create([{ id: "p1", authorId: "WRONG", title: "Post" }]),
      } as Record<string, unknown>,
    });

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorId"]).toBe("u1");
  });

  // PLAN Issue #22: a relation callback nested inside an already-nested record
  // is unsupported. The guard must throw a descriptive error rather than letting
  // IDB's structured-clone surface an opaque DataCloneError.
  it("rejects recursive nesting with a descriptive error (not DataCloneError)", async () => {
    await expect(
      executeNestedCreateMutation({
        executor,
        contract,
        modelName: "User",
        data: {
          id: "u1",
          name: "Alice",
          posts: (rel: RelMutator) =>
            // Inner record itself carries a relation callback → recursive nesting.
            rel.create([{ id: "p1", title: "Post", author: () => undefined } as Record<string, unknown>]),
        } as Record<string, unknown>,
      })
    ).rejects.toThrow(/[Rr]ecursive nested writes are not supported/);
  });
});

// ── executeNestedCreateMutation — N:1 parent-owned ───────────────────────────

describe("executeNestedCreateMutation — N:1 parent create + connect", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;
  const orm_ = () => idbOrm({ contract, executor });

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("N:1 nested create: creates related first, copies PK into parent FK", async () => {
    const row = await executeNestedCreateMutation({
      executor,
      contract,
      modelName: "Post",
      data: {
        id: "p1",
        title: "Post",
        author: (rel: RelMutator) => rel.create({ id: "u1", name: "Alice" }),
      } as Record<string, unknown>,
    });

    expect(row).toMatchObject({ id: "p1", authorId: "u1" });

    const users = await getAllRows(db, "users");
    const posts = await getAllRows(db, "posts");
    expect(users).toHaveLength(1);
    expect(posts[0]?.["authorId"]).toBe("u1");
  });

  it("N:1 nested connect: finds existing related row and copies PK", async () => {
    // Pre-seed the user
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);

    const row = await executeNestedCreateMutation({
      executor,
      contract,
      modelName: "Post",
      data: {
        id: "p1",
        title: "Post",
        author: (rel: RelMutator) => rel.connect({ id: "u1" }),
      } as Record<string, unknown>,
    });

    expect(row).toMatchObject({ id: "p1", authorId: "u1" });
  });

  it("N:1 nested connect throws when referenced row not found", async () => {
    await expect(
      executeNestedCreateMutation({
        executor,
        contract,
        modelName: "Post",
        data: {
          id: "p1",
          title: "Post",
          author: (rel: RelMutator) => rel.connect({ id: "nonexistent" }),
        } as Record<string, unknown>,
      })
    ).rejects.toThrow("connect");
  });
});

// ── executeNestedUpdateMutation ────────────────────────────────────────────────

describe("executeNestedUpdateMutation", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;
  const orm_ = () => idbOrm({ contract, executor });

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("returns null when no parent row matches the filters", async () => {
    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    const result = await executeNestedUpdateMutation({
      executor,
      contract,
      modelName: "User",
      filters: [fieldFilter("id", "eq", "nonexistent")],
      data: { posts: (rel: RelMutator) => rel.disconnect() } as Record<string, unknown>,
    });
    expect(result).toBeNull();
  });

  it("N:1 connect in update re-links the post to a new user", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "Post" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    const row = await executeNestedUpdateMutation({
      executor,
      contract,
      modelName: "Post",
      filters: [fieldFilter("id", "eq", "p1")],
      data: { author: (rel: RelMutator) => rel.connect({ id: "u2" }) } as Record<string, unknown>,
    });

    expect(row).toMatchObject({ id: "p1", authorId: "u2" });
    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorId"]).toBe("u2");
  });

  it("N:1 disconnect in update sets FK to null", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "Post" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    const row = await executeNestedUpdateMutation({
      executor,
      contract,
      modelName: "Post",
      filters: [fieldFilter("id", "eq", "p1")],
      data: { author: (rel: RelMutator) => rel.disconnect() } as Record<string, unknown>,
    });

    expect(row).toMatchObject({ id: "p1", authorId: null });
  });

  it("1:N disconnect-all sets FK to null on all children", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "P1" } as never);
    await orm_()["posts"]!.create({ id: "p2", authorId: "u1", title: "P2" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    await executeNestedUpdateMutation({
      executor,
      contract,
      modelName: "User",
      filters: [fieldFilter("id", "eq", "u1")],
      data: { posts: (rel: RelMutator) => rel.disconnect() } as Record<string, unknown>,
    });

    const posts = await getAllRows(db, "posts");
    expect(posts.every((p) => p["authorId"] === null)).toBe(true);
  });

  it("1:N disconnect with criteria targets only matching children", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "P1" } as never);
    await orm_()["posts"]!.create({ id: "p2", authorId: "u1", title: "P2" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    await executeNestedUpdateMutation({
      executor,
      contract,
      modelName: "User",
      filters: [fieldFilter("id", "eq", "u1")],
      data: { posts: (rel: RelMutator) => rel.disconnect([{ id: "p1" }]) } as Record<string, unknown>,
    });

    const posts = await getAllRows(db, "posts");
    const p1 = posts.find((p) => p["id"] === "p1");
    const p2 = posts.find((p) => p["id"] === "p2");
    expect(p1?.["authorId"]).toBeNull();
    expect(p2?.["authorId"]).toBe("u1");
  });
});

// ── child-owned connect matches ALL rows (PLAN Issue #24) ────────────────────

describe("executeNestedUpdateMutation — 1:N connect matches all", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("connect with a non-unique criterion connects every matching child", async () => {
    const orm = idbOrm({ contract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    // Two posts share a non-unique `title`; a third does not match.
    await orm["posts"]!.create({ id: "p1", title: "shared" } as never);
    await orm["posts"]!.create({ id: "p2", title: "shared" } as never);
    await orm["posts"]!.create({ id: "p3", title: "other" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    await executeNestedUpdateMutation({
      executor,
      contract,
      modelName: "User",
      filters: [fieldFilter("id", "eq", "u1")],
      data: { posts: (rel: RelMutator) => rel.connect([{ title: "shared" }]) } as Record<string, unknown>,
    });

    const posts = await getAllRows(db, "posts");
    expect(posts.find((p) => p["id"] === "p1")?.["authorId"]).toBe("u1");
    expect(posts.find((p) => p["id"] === "p2")?.["authorId"]).toBe("u1");
    // Non-matching child is untouched.
    expect(posts.find((p) => p["id"] === "p3")?.["authorId"]).toBeUndefined();
  });
});

// ── upsert is atomic when the executor supports transactions (Issue #24) ─────

describe("upsert — atomic path (transaction-capable executor)", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("inserts when no row matches, then updates the same row on re-upsert", async () => {
    const orm = idbOrm({ contract, executor });

    const created = await orm["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", name: "Alice" },
      update: { name: "Updated" },
    } as never);
    expect(created).toMatchObject({ id: "u1", name: "Alice" });

    const updated = await orm["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", name: "Alice" },
      update: { name: "Updated" },
    } as never);
    expect(updated).toMatchObject({ id: "u1", name: "Updated" });

    // Exactly one row — the second upsert updated rather than inserted.
    const users = await getAllRows(db, "users");
    expect(users).toHaveLength(1);
    expect(users[0]?.["name"]).toBe("Updated");
  });
});

// ── hasScalarFkFields ─────────────────────────────────────────────────────────

describe("hasScalarFkFields", () => {
  it("returns true when a N:1 localField is present and non-null", () => {
    expect(hasScalarFkFields(contract, "Post", { id: "p1", authorId: "u1", title: "T" })).toBe(true);
  });

  it("returns false when the FK field is null", () => {
    expect(hasScalarFkFields(contract, "Post", { id: "p1", authorId: null, title: "T" })).toBe(false);
  });

  it("returns false when the FK field is absent", () => {
    expect(hasScalarFkFields(contract, "Post", { id: "p1", title: "T" })).toBe(false);
  });

  it("returns false for a model with no N:1 relations", () => {
    expect(hasScalarFkFields(contract, "User", { id: "u1", name: "Alice" })).toBe(false);
  });
});

// ── scalar FK validation — create ─────────────────────────────────────────────

describe("scalar FK validation — create()", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("create with valid FK succeeds and stores the record", async () => {
    const orm = idbOrm({ contract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    const post = await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" } as never);
    expect(post).toMatchObject({ id: "p1", authorId: "u1" });
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
  });

  it("create with nonexistent FK throws a descriptive FK violation error", async () => {
    const orm = idbOrm({ contract, executor });
    await expect(orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "nonexistent" } as never)).rejects.toThrow(
      /FK violation.*author.*nonexistent/i
    );
  });

  it("create with null FK field skips validation and stores the record", async () => {
    const orm = idbOrm({ contract, executor });
    const post = await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: null } as never);
    expect(post).toMatchObject({ id: "p1", authorId: null });
  });

  it("create without FK field present skips validation and stores the record", async () => {
    const orm = idbOrm({ contract, executor });
    const post = await orm["posts"]!.create({ id: "p1", title: "Hello" } as never);
    expect(post).toMatchObject({ id: "p1" });
  });
});

// ── scalar FK validation — update ─────────────────────────────────────────────

describe("scalar FK validation — update()", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("update with valid FK succeeds and updates the record", async () => {
    const orm = idbOrm({ contract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" } as never);
    const updated = await orm["posts"]!.where({ id: "p1" } as never).update({ authorId: "u2" } as never);
    expect(updated).toMatchObject({ id: "p1", authorId: "u2" });
  });

  it("update with nonexistent FK throws a descriptive FK violation error", async () => {
    const orm = idbOrm({ contract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" } as never);
    await expect(orm["posts"]!.where({ id: "p1" } as never).update({ authorId: "ghost" } as never)).rejects.toThrow(
      /FK violation.*author.*ghost/i
    );
  });

  it("update setting FK to null skips validation", async () => {
    const orm = idbOrm({ contract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" } as never);
    const updated = await orm["posts"]!.where({ id: "p1" } as never).update({ authorId: null } as never);
    expect(updated).toMatchObject({ id: "p1", authorId: null });
  });
});
