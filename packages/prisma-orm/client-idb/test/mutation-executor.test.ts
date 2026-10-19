/**
 * Nested mutation behavior through the public ORM.
 *
 * Exercises nested writes against fake-indexeddb:
 *   ORM nested create — 1:N and N:1 nested creates
 *   ORM nested create — N:1 nested connect
 *   ORM nested update — N:1 connect + disconnect, 1:N disconnect
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
import { idbOrm, IdbRecordValidationError } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction, IdbRelationMutator } from "../src/exports/orm";

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
      fields: { id: "String", authorId: "String?", title: "String" },
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
      db.createObjectStore("posts", { keyPath: "id" }).createIndex("authorId", "authorId");
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

// ── ORM nested create — 1:N child-owned ─────────────────────────────

describe("ORM nested create — 1:N child create", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("creates parent and children in one transaction", async () => {
    const row = await idbOrm({ contract, executor })["users"]!.create({
      id: "u1",
      name: "Alice",
      posts: (rel: RelMutator) =>
        rel.create([
          { id: "p1", authorId: "placeholder", title: "Post 1" },
          { id: "p2", authorId: "placeholder", title: "Post 2" },
        ]),
    } as never);

    expect(row).toMatchObject({ id: "u1", name: "Alice" });

    const users = await getAllRows(db, "users");
    const posts = await getAllRows(db, "posts");
    expect(users).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p["authorId"] === "u1")).toBe(true);
  });

  it("injects parent FK into children, overwriting any supplied value", async () => {
    await idbOrm({ contract, executor })["users"]!.create({
      id: "u1",
      name: "Alice",
      posts: (rel: RelMutator) => rel.create([{ id: "p1", authorId: "WRONG", title: "Post" }]),
    } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorId"]).toBe("u1");
  });

  // A relation callback nested inside an already-nested record
  // is unsupported. The guard must throw a descriptive error rather than letting
  // IDB's structured-clone surface an opaque DataCloneError.
  it("rejects recursive nesting with a descriptive error (not DataCloneError)", async () => {
    await expect(
      idbOrm({ contract, executor })["users"]!.create({
        id: "u1",
        name: "Alice",
        posts: (rel: RelMutator) =>
          // Inner record itself carries a relation callback → recursive nesting.
          rel.create([{ id: "p1", title: "Post", author: () => undefined } as Record<string, unknown>]),
      } as never)
    ).rejects.toThrow(/[Rr]ecursive nested writes are not supported/);
  });
});

// ── ORM nested create — N:1 parent-owned ───────────────────────────

describe("ORM nested create — N:1 parent create + connect", () => {
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
    const row = await idbOrm({ contract, executor })["posts"]!.create({
      id: "p1",
      title: "Post",
      author: (rel: RelMutator) => rel.create({ id: "u1", name: "Alice" }),
    } as never);

    expect(row).toMatchObject({ id: "p1", authorId: "u1" });

    const users = await getAllRows(db, "users");
    const posts = await getAllRows(db, "posts");
    expect(users).toHaveLength(1);
    expect(posts[0]?.["authorId"]).toBe("u1");
  });

  it("N:1 nested connect: finds existing related row and copies PK", async () => {
    // Pre-seed the user
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);

    const row = await idbOrm({ contract, executor })["posts"]!.create({
      id: "p1",
      title: "Post",
      author: (rel: RelMutator) => rel.connect({ id: "u1" }),
    } as never);

    expect(row).toMatchObject({ id: "p1", authorId: "u1" });
  });

  it("N:1 nested connect throws when referenced row not found", async () => {
    await expect(
      idbOrm({ contract, executor })["posts"]!.create({
        id: "p1",
        title: "Post",
        author: (rel: RelMutator) => rel.connect({ id: "nonexistent" }),
      } as never)
    ).rejects.toThrow("connect");
  });
});

// ── Public nested updates ────────────────────────────────────────────────────

describe("ORM nested update", () => {
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
    const result = await idbOrm({ contract, executor })
      ["users"]!.where(() => fieldFilter("id", "eq", "nonexistent"))
      .update({ posts: (rel: RelMutator) => rel.disconnect() } as never);
    expect(result).toBeNull();
  });

  it("N:1 connect in update re-links the post to a new user", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "Post" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    const row = await idbOrm({ contract, executor })
      ["posts"]!.where(() => fieldFilter("id", "eq", "p1"))
      .update({ author: (rel: RelMutator) => rel.connect({ id: "u2" }) } as never);

    expect(row).toMatchObject({ id: "p1", authorId: "u2" });
    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorId"]).toBe("u2");
  });

  it("N:1 disconnect in update sets FK to null", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "Post" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    const row = await idbOrm({ contract, executor })
      ["posts"]!.where(() => fieldFilter("id", "eq", "p1"))
      .update({ author: (rel: RelMutator) => rel.disconnect() } as never);

    expect(row).toMatchObject({ id: "p1", authorId: null });
  });

  it("1:N disconnect-all sets FK to null on all children", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "P1" } as never);
    await orm_()["posts"]!.create({ id: "p2", authorId: "u1", title: "P2" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    await idbOrm({ contract, executor })
      ["users"]!.where(() => fieldFilter("id", "eq", "u1"))
      .update({ posts: (rel: RelMutator) => rel.disconnect() } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts.every((p) => p["authorId"] === null)).toBe(true);
  });

  it("1:N disconnect with criteria targets only matching children", async () => {
    await orm_()["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm_()["posts"]!.create({ id: "p1", authorId: "u1", title: "P1" } as never);
    await orm_()["posts"]!.create({ id: "p2", authorId: "u1", title: "P2" } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    await idbOrm({ contract, executor })
      ["users"]!.where(() => fieldFilter("id", "eq", "u1"))
      .update({ posts: (rel: RelMutator) => rel.disconnect([{ id: "p1" }]) } as never);

    const posts = await getAllRows(db, "posts");
    const p1 = posts.find((p) => p["id"] === "p1");
    const p2 = posts.find((p) => p["id"] === "p2");
    expect(p1?.["authorId"]).toBeNull();
    expect(p2?.["authorId"]).toBe("u1");
  });
});

// ── child-owned connect matches ALL rows ────────────────────

describe("ORM nested update — 1:N connect matches all", () => {
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
    await orm["posts"]!.create({ id: "p1", title: "shared", authorId: null } as never);
    await orm["posts"]!.create({ id: "p2", title: "shared", authorId: null } as never);
    await orm["posts"]!.create({ id: "p3", title: "other", authorId: null } as never);

    const { fieldFilter } = await import("@prisma-idb/adapter-idb/runtime");
    await idbOrm({ contract, executor })
      ["users"]!.where(() => fieldFilter("id", "eq", "u1"))
      .update({ posts: (rel: RelMutator) => rel.connect([{ title: "shared" }]) } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts.find((p) => p["id"] === "p1")?.["authorId"]).toBe("u1");
    expect(posts.find((p) => p["id"] === "p2")?.["authorId"]).toBe("u1");
    // Non-matching child is untouched.
    expect(posts.find((p) => p["id"] === "p3")?.["authorId"]).toBeNull();
  });
});

// ── upsert is atomic when the executor supports transactions ─────

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

  it("create without a nullable FK stores it as null", async () => {
    const orm = idbOrm({ contract, executor });
    expect(await orm["posts"]!.create({ id: "p1", title: "Hello" })).toMatchObject({ id: "p1", authorId: null });
    expect(await orm["posts"]!.findUnique("p1")).toMatchObject({ id: "p1", authorId: null });
  });

  it("create without a required field still rejects the incomplete record", async () => {
    const orm = idbOrm({ contract, executor });
    await expect(orm["posts"]!.create({ id: "p1" } as never)).rejects.toThrow(IdbRecordValidationError);
    expect(await orm["posts"]!.all()).toEqual([]);
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

describe("ORM nested scalar validation", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;
  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("rolls back the parent and earlier valid children when a later child is invalid", async () => {
    const orm = idbOrm({ contract, executor });
    await expect(
      orm["users"]!.create({
        id: "u1",
        name: "Alice",
        posts: (rel: RelMutator) =>
          rel.create([
            { id: "p1", title: "valid" },
            { id: "p2", title: 3 },
          ]),
      } as never)
    ).rejects.toThrow(IdbRecordValidationError);
    expect(await orm["users"]!.all()).toEqual([]);
    expect(await orm["posts"]!.all()).toEqual([]);
  });

  it("rolls back a nested parent-owned create when the outer update is invalid", async () => {
    const orm = idbOrm({ contract, executor });
    await orm["posts"]!.create({ id: "p1", title: "before", authorId: null } as never);
    await expect(
      orm["posts"]!.where({ id: "p1" }).update({
        title: 3,
        author: (rel: RelMutator) => rel.create({ id: "u1", name: "Alice" }),
      } as never)
    ).rejects.toThrow(IdbRecordValidationError);
    expect(await orm["users"]!.all()).toEqual([]);
    expect(await orm["posts"]!.findUnique("p1")).toMatchObject({ title: "before", authorId: null });
  });

  it.each(["disconnect-all", "disconnect-key", "delete"])("rolls back invalid generated %s patches", async (action) => {
    const requiredContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", name: "String" },
          relations: {
            posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "setNull" },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", title: "String", authorId: "String" },
          relations: {
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
          },
        },
      },
    });
    const orm = idbOrm({ contract: requiredContract, executor });
    await orm["users"]!.create({ id: "u1", name: "before" } as never);
    await orm["posts"]!.create({ id: "p1", title: "before", authorId: "u1" } as never);
    const write =
      action === "delete"
        ? orm["users"]!.delete("u1")
        : orm["users"]!.where({ id: "u1" }).update({
            name: "after",
            posts: (rel: RelMutator) =>
              action === "disconnect-key" ? rel.disconnect([{ id: "p1" }]) : rel.disconnect(),
          } as never);
    await expect(write).rejects.toThrow(IdbRecordValidationError);
    expect(await orm["users"]!.findUnique("u1")).toMatchObject({ name: "before" });
    expect(await orm["posts"]!.findUnique("p1")).toMatchObject({ authorId: "u1" });
  });

  it.each(["createAll", "createCount"] as const)("rolls back invalid scalar data in FK %s batches", async (method) => {
    const orm = idbOrm({ contract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    const write = async () =>
      await orm["posts"]![method]([
        { id: "p1", title: "valid", authorId: "u1" },
        { id: "p2", title: 3, authorId: "u1" },
      ] as never);
    await expect(write()).rejects.toThrow(IdbRecordValidationError);
    expect(await orm["posts"]!.all()).toEqual([]);
  });
});
