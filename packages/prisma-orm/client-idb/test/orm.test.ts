/**
 * Client IDB ORM tests.
 *
 * Uses fake-indexeddb (injected globally by vitest.config.ts setupFiles) and a
 * minimal in-process executor that wraps IdbRuntimeDriverInstance.execute()
 * inside AsyncIterableResult so it satisfies IdbQueryExecutor without needing
 * the full runtime stack.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import type { FieldSpec } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction, IdbStoreAccessor } from "../src/exports/orm";

// ── Test-only cast helper ─────────────────────────────────────────────────────

/**
 * Cast the ORM client to a plain record so tests can access properties via
 * bracket notation without TS complaining about index signatures on mapped types.
 */
function asRecord(client: unknown): Record<string, IdbStoreAccessor<never, never>> {
  return client as Record<string, IdbStoreAccessor<never, never>>;
}

// ── Test executor ─────────────────────────────────────────────────────────────

/**
 * Wraps an IdbRuntimeDriverInstance so it satisfies IdbQueryExecutor.
 * The adapter is a passthrough (idbPlan ≡ planBody), so we extract idbPlan
 * directly instead of going through the full runtime stack.
 */
class TestExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  readonly #driver: IdbRuntimeDriverInstance;

  constructor(driver: IdbRuntimeDriverInstance) {
    this.#driver = driver;
  }

  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const iterable = this.#driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of iterable) {
          yield row as Row;
        }
      })()
    );
  }

  // Delegates straight to the driver, which already supports it (same
  // pattern as fk-enforcement.test.ts's TestExecutorWithTransaction) — purely
  // additive: nothing outside updateAll()/deleteAll() calls .transaction() on
  // this executor, so every other describe block in this file is unaffected.
  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.#driver.transaction(storeNames, mode);
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

let dbCounter = 0;
function dbName(): string {
  return `client-idb-orm-test-${++dbCounter}`;
}

type StoreIndex = { name: string; keyPath: string; unique?: boolean };
type StoreSpec = { name: string; keyPath: string; indexes?: StoreIndex[] };

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

function seedStore(db: IDBDatabase, storeName: string, records: Record<string, unknown>[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Test contract ─────────────────────────────────────────────────────────────

function makeTestContract(
  _roots: Record<string, string>,
  models: Record<
    string,
    {
      storeName: string;
      keyPath: string;
      relations?: Record<
        string,
        { to: string; cardinality: "1:1" | "1:N" | "N:1"; on: { localFields: string[]; targetFields: string[] } }
      >;
    }
  >
) {
  const defModels: Record<
    string,
    {
      store: string;
      key: string;
      fields: Record<string, FieldSpec>;
      relations?: Record<
        string,
        { to: string; cardinality: "1:1" | "1:N" | "N:1"; on: { local: string[]; target: string[] } }
      >;
    }
  > = {};
  for (const [name, spec] of Object.entries(models)) {
    const relations: (typeof defModels)[string]["relations"] = {};
    for (const [relName, rel] of Object.entries(spec.relations ?? {})) {
      relations[relName] = {
        to: rel.to,
        cardinality: rel.cardinality,
        on: { local: rel.on.localFields, target: rel.on.targetFields },
      };
    }
    defModels[name] = {
      store: spec.storeName,
      key: spec.keyPath,
      fields: { [spec.keyPath]: "String" },
      ...(Object.keys(relations).length > 0 ? { relations } : {}),
    };
  }
  return defineContract({ family: idbFamilyPack, target: idbTargetPack, models: defModels });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const USERS_STORE: StoreSpec = { name: "users", keyPath: "id" };
const POSTS_STORE: StoreSpec = {
  name: "posts",
  keyPath: "id",
  indexes: [{ name: "byAuthorId", keyPath: "authorId" }],
};

const ALICE = { id: "u1", name: "Alice", email: "alice@example.com" };
const BOB = { id: "u2", name: "Bob", email: "bob@example.com" };
const POST_A = { id: "p1", title: "Hello", authorId: "u1" };
const POST_B = { id: "p2", title: "World", authorId: "u1" };
const POST_C = { id: "p3", title: "Other", authorId: "u2" };

describe("idbOrm factory", () => {
  it("returns a client with keys from contract.roots", () => {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    const driver = createIDBRuntimeDriver("no-db", 1).create();
    const client = idbOrm({ contract, executor: new TestExecutor(driver) });
    expect(client).toHaveProperty("users");
  });

  it("exposes all root keys from the contract", () => {
    const contract = makeTestContract(
      { users: "User", posts: "Post" },
      {
        User: { storeName: "users", keyPath: "id" },
        Post: { storeName: "posts", keyPath: "id" },
      }
    );
    const driver = createIDBRuntimeDriver("no-db", 1).create();
    const client = idbOrm({ contract, executor: new TestExecutor(driver) });
    expect(client).toHaveProperty("users");
    expect(client).toHaveProperty("posts");
  });
});

describe("IdbStoreAccessor — create / read", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    // Close setup db; driver will re-open at version 1 (no upgrade needed)
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("create() inserts a record and returns it", async () => {
    const client = makeClient();
    const result = await client["users"]!.create({ id: "u1", name: "Alice", email: "alice@example.com" });
    expect(result).toMatchObject({ id: "u1", name: "Alice" });
  });

  it("create() rejects instead of overwriting an existing primary key", async () => {
    const client = makeClient();
    await client["users"]!.create({ id: "u1", name: "Alice", email: "alice@example.com" });

    await expect(
      client["users"]!.create({ id: "u1", name: "Updated", email: "updated@example.com" })
    ).rejects.toMatchObject({ code: "ADD_FAILED" });

    const stored = await client["users"]!.findUnique("u1");
    expect(stored).toMatchObject({ id: "u1", name: "Alice", email: "alice@example.com" });
  });

  it("all() returns all records", async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    setupDb.close();

    const d = createIDBRuntimeDriver(name, 1).create();
    const e = new TestExecutor(d);
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    const client = asRecord(idbOrm({ contract, executor: e }));

    const rows = await client["users"]!.all().toArray();
    expect(rows).toHaveLength(2);
    await d.close();
  });

  it("all() returns empty array when store is empty", async () => {
    const client = makeClient();
    const rows = await client["users"]!.all().toArray();
    expect(rows).toHaveLength(0);
  });
});

describe("IdbStoreAccessor — where / take / skip / orderBy", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("where() filters rows by field", async () => {
    const client = makeClient();
    const rows = await client["users"]!.where({ name: "Alice" }).all().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Alice" });
  });

  it("where() with no match returns empty", async () => {
    const client = makeClient();
    const rows = await client["users"]!.where({ name: "Nobody" }).all().toArray();
    expect(rows).toHaveLength(0);
  });

  it("take() limits result count", async () => {
    const client = makeClient();
    const rows = await client["users"]!.take(1).all().toArray();
    expect(rows).toHaveLength(1);
  });

  it("skip() skips records", async () => {
    const client = makeClient();
    const rows = await client["users"]!.skip(1).all().toArray();
    expect(rows).toHaveLength(1);
  });

  it("orderBy() sorts ascending", async () => {
    const client = makeClient();
    const rows = await client["users"]!.orderBy({ name: "asc" }).all().toArray();
    const names = rows.map((r) => (r as Record<string, unknown>)["name"]);
    expect(names).toEqual(["Alice", "Bob"]);
  });

  it("orderBy() sorts descending", async () => {
    const client = makeClient();
    const rows = await client["users"]!.orderBy({ name: "desc" }).all().toArray();
    const names = rows.map((r) => (r as Record<string, unknown>)["name"]);
    expect(names).toEqual(["Bob", "Alice"]);
  });

  it("first() returns first match", async () => {
    const client = makeClient();
    const row = await client["users"]!.first();
    expect(row).not.toBeNull();
  });

  it("first() returns null when no match", async () => {
    const client = makeClient();
    const row = await client["users"]!.where({ name: "Nobody" }).first();
    expect(row).toBeNull();
  });
});

describe("IdbStoreAccessor — findUnique / delete", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;
  let name: string;

  beforeEach(async () => {
    name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("findUnique() returns matching row by key", async () => {
    const client = makeClient();
    const row = await client["users"]!.findUnique("u1");
    expect(row).toMatchObject({ id: "u1", name: "Alice" });
  });

  it("findUnique() returns null for missing key", async () => {
    const client = makeClient();
    const row = await client["users"]!.findUnique("nonexistent");
    expect(row).toBeNull();
  });

  it("delete() removes a record", async () => {
    const client = makeClient();
    await client["users"]!.delete("u1");
    const row = await client["users"]!.findUnique("u1");
    expect(row).toBeNull();
  });

  it("delete() is a no-op for nonexistent key", async () => {
    const client = makeClient();
    // Should not throw
    await expect(client["users"]!.delete("nonexistent")).resolves.toBeUndefined();
  });
});

describe("IdbStoreAccessor — include (relations)", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE, POSTS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    await seedStore(setupDb, "posts", [POST_A, POST_B, POST_C]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("include() loads a 1:N relation", async () => {
    const contract = makeTestContract(
      { users: "User" },
      {
        User: {
          storeName: "users",
          keyPath: "id",
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { localFields: ["id"], targetFields: ["authorId"] },
            },
          },
        },
        Post: {
          storeName: "posts",
          keyPath: "id",
        },
      }
    );
    const client = asRecord(idbOrm({ contract, executor }));
    const rows = await client["users"]!.include("posts").all().toArray();
    const alice = rows.find((r) => (r as Record<string, unknown>)["id"] === "u1");
    expect(alice).toBeDefined();
    const posts = (alice as Record<string, unknown>)["posts"];
    expect(Array.isArray(posts)).toBe(true);
    expect((posts as unknown[]).length).toBe(2);
  });

  it("include() loads a N:1 relation", async () => {
    const contract = makeTestContract(
      { posts: "Post" },
      {
        Post: {
          storeName: "posts",
          keyPath: "id",
          relations: {
            author: {
              to: "User",
              cardinality: "N:1",
              on: { localFields: ["authorId"], targetFields: ["id"] },
            },
          },
        },
        User: {
          storeName: "users",
          keyPath: "id",
        },
      }
    );
    const client = asRecord(idbOrm({ contract, executor }));
    const rows = await client["posts"]!.include("author").all().toArray();
    const postA = rows.find((r) => (r as Record<string, unknown>)["id"] === "p1");
    expect(postA).toBeDefined();
    const author = (postA as Record<string, unknown>)["author"];
    expect(author).toBeDefined();
    expect((author as Record<string, unknown>)["id"]).toBe("u1");
  });
});

// ── Phase 6.5 / 6.6 / 6.7 fixtures ─────────────────────────────────────────────

// Posts seeded with `published` + `views` so refinement / aggregate tests have
// something to filter, order, and reduce over. Field values matter at runtime;
// the contract stays loosely typed (defineContract) so any field name resolves.
const R_POSTS = [
  { id: "p1", title: "Alpha", authorId: "u1", published: true, views: 100 },
  { id: "p2", title: "Beta", authorId: "u1", published: false, views: 50 },
  { id: "p3", title: "Gamma", authorId: "u1", published: true, views: 75 },
  { id: "p4", title: "Delta", authorId: "u2", published: true, views: 200 },
  { id: "p5", title: "Epsilon", authorId: "u2", published: false, views: 0 },
];

function usersWithPostsContract() {
  return makeTestContract(
    { users: "User", posts: "Post" },
    {
      User: {
        storeName: "users",
        keyPath: "id",
        relations: {
          posts: { to: "Post", cardinality: "1:N", on: { localFields: ["id"], targetFields: ["authorId"] } },
        },
      },
      Post: {
        storeName: "posts",
        keyPath: "id",
        relations: {
          author: { to: "User", cardinality: "N:1", on: { localFields: ["authorId"], targetFields: ["id"] } },
        },
      },
    }
  );
}

describe("IdbStoreAccessor — include refinement (Phase 6.5)", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE, POSTS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    await seedStore(setupDb, "posts", R_POSTS);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  function postsOf(row: unknown): Record<string, unknown>[] {
    return (row as Record<string, unknown>)["posts"] as Record<string, unknown>[];
  }
  function findUser(rows: unknown[], id: string): unknown {
    return rows.find((r) => (r as Record<string, unknown>)["id"] === id);
  }

  it("refined include filters child rows with where()", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts", (p) => p.where({ published: true }))
      .all()
      .toArray();
    expect(postsOf(findUser(rows, "u1"))).toHaveLength(2); // p1, p3
    expect(postsOf(findUser(rows, "u2"))).toHaveLength(1); // p4
  });

  it("refined include applies orderBy + take per parent group", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts", (p) => p.orderBy({ views: "desc" }).take(1))
      .all()
      .toArray();
    const aliceTop = postsOf(findUser(rows, "u1"));
    expect(aliceTop).toHaveLength(1);
    expect(aliceTop[0]!["id"]).toBe("p1"); // 100 is alice's max
    const bobTop = postsOf(findUser(rows, "u2"));
    expect(bobTop[0]!["id"]).toBe("p4"); // 200 is bob's max
  });

  it("refined include composes where + orderBy", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts", (p) => p.where({ published: true }).orderBy({ views: "asc" }))
      .all()
      .toArray();
    const alice = postsOf(findUser(rows, "u1")).map((r) => r["id"]);
    expect(alice).toEqual(["p3", "p1"]); // published, ascending by views (75, 100)
  });

  it("refined include skip paginates per parent group", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts", (p) => p.orderBy({ views: "asc" }).skip(1))
      .all()
      .toArray();
    const alice = postsOf(findUser(rows, "u1")).map((r) => r["id"]);
    expect(alice).toEqual(["p3", "p1"]); // drop the lowest (p2=50), keep 75, 100
  });

  it("scalar count() include reduces a to-many relation to a number", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts", (p) => p.count())
      .all()
      .toArray();
    expect((findUser(rows, "u1") as Record<string, unknown>)["posts"]).toBe(3);
    expect((findUser(rows, "u2") as Record<string, unknown>)["posts"]).toBe(2);
  });

  it("scalar count() include honours a refined where()", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts", (p) => p.where({ published: true }).count())
      .all()
      .toArray();
    expect((findUser(rows, "u1") as Record<string, unknown>)["posts"]).toBe(2);
    expect((findUser(rows, "u2") as Record<string, unknown>)["posts"]).toBe(1);
  });

  it("scalar count() on a to-one relation throws", () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    expect(() => client["posts"]!.include("author", (a) => a.count())).toThrow(/to-many/);
  });

  it("unrefined include still loads all child rows (regression)", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts").all().toArray();
    expect(postsOf(findUser(rows, "u1"))).toHaveLength(3);
  });
});

describe("IdbStoreAccessor — aggregate / groupBy (Phase 6.6)", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [POSTS_STORE]);
    await seedStore(setupDb, "posts", R_POSTS);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  function postsClient() {
    const contract = makeTestContract({ posts: "Post" }, { Post: { storeName: "posts", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("aggregate() computes count/sum/avg/min/max over all rows", async () => {
    const result = await postsClient()["posts"]!.aggregate((agg) => ({
      total: agg.count(),
      totalViews: agg.sum("views"),
      avgViews: agg.avg("views"),
      minViews: agg.min("views"),
      maxViews: agg.max("views"),
    }));
    expect(result).toEqual({ total: 5, totalViews: 425, avgViews: 85, minViews: 0, maxViews: 200 });
  });

  it("aggregate() respects the accumulated where() filter", async () => {
    const result = await postsClient()
      ["posts"]!.where({ published: true })
      .aggregate((agg) => ({ count: agg.count(), sum: agg.sum("views") }));
    expect(result).toEqual({ count: 3, sum: 375 }); // p1 100 + p3 75 + p4 200
  });

  it("aggregate() over an empty set: count 0, reducers null", async () => {
    const result = await postsClient()
      ["posts"]!.where({ id: "does-not-exist" })
      .aggregate((agg) => ({
        count: agg.count(),
        sum: agg.sum("views"),
        avg: agg.avg("views"),
        min: agg.min("views"),
      }));
    expect(result).toEqual({ count: 0, sum: null, avg: null, min: null });
  });

  it("aggregate() with an empty spec throws", async () => {
    await expect(postsClient()["posts"]!.aggregate(() => ({}))).rejects.toThrow(/at least one/);
  });

  it("groupBy().aggregate() produces one row per group with the key field", async () => {
    const rows = await postsClient()
      ["posts"]!.groupBy("authorId")
      .aggregate((agg) => ({ count: agg.count(), totalViews: agg.sum("views") }));
    expect(rows).toHaveLength(2);
    const byAuthor = Object.fromEntries(rows.map((r) => [(r as Record<string, unknown>)["authorId"], r]));
    expect(byAuthor["u1"]).toEqual({ authorId: "u1", count: 3, totalViews: 225 });
    expect(byAuthor["u2"]).toEqual({ authorId: "u2", count: 2, totalViews: 200 });
  });

  it("groupBy().aggregate() respects a preceding where()", async () => {
    const rows = await postsClient()
      ["posts"]!.where({ published: true })
      .groupBy("authorId")
      .aggregate((agg) => ({ count: agg.count(), totalViews: agg.sum("views") }));
    const byAuthor = Object.fromEntries(rows.map((r) => [(r as Record<string, unknown>)["authorId"], r]));
    expect(byAuthor["u1"]).toEqual({ authorId: "u1", count: 2, totalViews: 175 }); // p1 100 + p3 75
    expect(byAuthor["u2"]).toEqual({ authorId: "u2", count: 1, totalViews: 200 }); // p4
  });

  it("groupBy().aggregate() with an empty spec throws", async () => {
    await expect(
      postsClient()
        ["posts"]!.groupBy("authorId")
        .aggregate(() => ({}))
    ).rejects.toThrow(/at least one/);
  });
});

describe("IdbStoreAccessor — select projection (Phase 6.7)", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE, POSTS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    await seedStore(setupDb, "posts", R_POSTS);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("select() narrows the row to the chosen fields", async () => {
    const contract = makeTestContract({ posts: "Post" }, { Post: { storeName: "posts", keyPath: "id" } });
    const client = asRecord(idbOrm({ contract, executor }));
    const rows = await client["posts"]!.select("id", "title").all().toArray();
    expect(rows).toHaveLength(5);
    expect(Object.keys(rows[0] as Record<string, unknown>).sort()).toEqual(["id", "title"]);
  });

  it("select() composes with where()", async () => {
    const contract = makeTestContract({ posts: "Post" }, { Post: { storeName: "posts", keyPath: "id" } });
    const client = asRecord(idbOrm({ contract, executor }));
    const rows = await client["posts"]!.where({ published: true }).select("id").all().toArray();
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Object.keys(row as Record<string, unknown>)).toEqual(["id"]);
  });

  it("select() preserves included relation fields", async () => {
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.include("posts").select("id", "name").all().toArray();
    const alice = rows.find((r) => (r as Record<string, unknown>)["id"] === "u1") as Record<string, unknown>;
    expect(Object.keys(alice).sort()).toEqual(["id", "name", "posts"]);
    expect(alice["email"]).toBeUndefined();
    expect(Array.isArray(alice["posts"])).toBe(true);
  });

  it("include() works even when the FK field is not selected", async () => {
    // The local FK ("id") is stripped by select("name"), but relation loading
    // runs before projection, so posts still resolve correctly.
    const client = asRecord(idbOrm({ contract: usersWithPostsContract(), executor }));
    const rows = await client["users"]!.select("name").include("posts").all().toArray();
    const alice = rows.find((r) => (r as Record<string, unknown>)["name"] === "Alice") as Record<string, unknown>;
    expect(Object.keys(alice).sort()).toEqual(["name", "posts"]);
    expect((alice["posts"] as unknown[]).length).toBe(3);
  });
});

// ── CRUD terminals ────────────────────────────────────────────────────────────

describe("IdbStoreAccessor — update", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });
  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("updates and returns the first matching row", async () => {
    const client = makeClient();
    const row = await client["users"]!.where({ id: "u1" }).update({ name: "ALICE" });
    expect(row).toMatchObject({ id: "u1", name: "ALICE", email: "alice@example.com" });
  });

  it("preserves fields not in the patch", async () => {
    const client = makeClient();
    await client["users"]!.where({ id: "u1" }).update({ name: "X" });
    const verify = await client["users"]!.findUnique("u1");
    expect(verify).toMatchObject({ id: "u1", name: "X", email: "alice@example.com" });
  });

  it("returns null when no row matches", async () => {
    const client = makeClient();
    const row = await client["users"]!.where({ id: "does-not-exist" }).update({ name: "X" });
    expect(row).toBeNull();
  });

  it("updates only the first matching row (take:1 semantics)", async () => {
    const client = makeClient();
    // Both rows pass the empty filter — only first should be updated
    await client["users"]!.update({ name: "FIRST" });
    const rows = await client["users"]!.all().toArray();
    const updated = (rows as Record<string, unknown>[]).filter((r) => r["name"] === "FIRST");
    expect(updated).toHaveLength(1);
  });
});

describe("IdbStoreAccessor — updateAll / updateCount", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB, { id: "u3", name: "Carol", email: "carol@x.com" }]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });
  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("updateAll returns AsyncIterableResult of merged rows", async () => {
    const client = makeClient();
    const result = client["users"]!.where({ id: "u1" }).updateAll({ name: "ALICE" });
    const rows = await result.toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)["name"]).toBe("ALICE");
  });

  it("updateAll updates multiple matching rows", async () => {
    const client = makeClient();
    const rows = await client["users"]!.updateAll({ name: "UPDATED" }).toArray();
    expect(rows).toHaveLength(3);
    expect((rows as Record<string, unknown>[]).every((r) => r["name"] === "UPDATED")).toBe(true);
  });

  it("updateAll returns empty array when no matches", async () => {
    const client = makeClient();
    const rows = await client["users"]!.where({ id: "nonexistent" }).updateAll({ name: "X" }).toArray();
    expect(rows).toHaveLength(0);
  });

  it("updateCount returns number of updated rows", async () => {
    const client = makeClient();
    const n = await client["users"]!.updateCount({ name: "X" });
    expect(n).toBe(3);
  });

  it("updateCount returns 0 when no matches", async () => {
    const client = makeClient();
    const n = await client["users"]!.where({ id: "nonexistent" }).updateCount({ name: "X" });
    expect(n).toBe(0);
  });
});

describe("IdbStoreAccessor — upsert", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });
  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("inserts and returns new row when not found (create path)", async () => {
    const client = makeClient();
    const row = await client["users"]!.upsert({
      where: { id: "u99" },
      create: { id: "u99", name: "New", email: "new@x.com" },
      update: { name: "Updated" },
    });
    expect(row).toMatchObject({ id: "u99", name: "New" });
    const verify = await client["users"]!.findUnique("u99");
    expect(verify).not.toBeNull();
  });

  it("updates and returns existing row when found (update path)", async () => {
    const client = makeClient();
    const row = await client["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", name: "Alice New", email: "new@x.com" },
      update: { name: "Alice Updated" },
    });
    expect(row).toMatchObject({ id: "u1", name: "Alice Updated" });
  });

  it("does not duplicate rows on update path", async () => {
    const client = makeClient();
    await client["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", name: "Dup", email: "dup@x.com" },
      update: { name: "No Dup" },
    });
    const rows = await client["users"]!.all().toArray();
    expect(rows).toHaveLength(1);
  });
});

describe("IdbStoreAccessor — createAll / createCount", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });
  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("createAll inserts all records and returns them", async () => {
    const client = makeClient();
    const rows = await client["users"]!.createAll([ALICE, BOB]).toArray();
    expect(rows).toHaveLength(2);
    expect((rows as Record<string, unknown>[]).map((r) => r["id"]).sort()).toEqual(["u1", "u2"]);
  });

  it("createAll persists all records", async () => {
    const client = makeClient();
    await client["users"]!.createAll([ALICE, BOB]).toArray();
    const all = await client["users"]!.all().toArray();
    expect(all).toHaveLength(2);
  });

  it("createCount returns count of inserted records", async () => {
    const client = makeClient();
    const n = await client["users"]!.createCount([ALICE, BOB]);
    expect(n).toBe(2);
  });

  it("createCount returns 0 for empty input", async () => {
    const client = makeClient();
    const n = await client["users"]!.createCount([]);
    expect(n).toBe(0);
  });
});

describe("IdbStoreAccessor — deleteAll / deleteCount", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB, { id: "u3", name: "Carol", email: "carol@x.com" }]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });
  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("deleteAll returns deleted rows", async () => {
    const client = makeClient();
    const rows = await client["users"]!.where({ id: "u1" }).deleteAll().toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)["id"]).toBe("u1");
  });

  it("deleteAll removes rows from the store", async () => {
    const client = makeClient();
    await client["users"]!.where({ id: "u1" }).deleteAll().toArray();
    const remaining = await client["users"]!.all().toArray();
    expect(remaining).toHaveLength(2);
    expect((remaining as Record<string, unknown>[]).map((r) => r["id"])).not.toContain("u1");
  });

  it("deleteAll deletes all rows when no filter", async () => {
    const client = makeClient();
    const rows = await client["users"]!.deleteAll().toArray();
    expect(rows).toHaveLength(3);
    const remaining = await client["users"]!.all().toArray();
    expect(remaining).toHaveLength(0);
  });

  it("deleteCount returns number of deleted rows", async () => {
    const client = makeClient();
    const n = await client["users"]!.where({ id: "u1" }).deleteCount();
    expect(n).toBe(1);
  });

  it("deleteCount returns 0 when no matches", async () => {
    const client = makeClient();
    const n = await client["users"]!.where({ id: "nonexistent" }).deleteCount();
    expect(n).toBe(0);
  });
});

describe("IdbStoreAccessor — count", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const setupDb = await openTestDb(name, [USERS_STORE]);
    await seedStore(setupDb, "users", [ALICE, BOB]);
    setupDb.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });
  afterEach(async () => {
    await driver.close();
  });

  function makeClient() {
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    return asRecord(idbOrm({ contract, executor }));
  }

  it("counts all rows when no filter", async () => {
    const client = makeClient();
    expect(await client["users"]!.count()).toBe(2);
  });

  it("counts filtered rows", async () => {
    const client = makeClient();
    expect(await client["users"]!.where({ id: "u1" }).count()).toBe(1);
  });

  it("returns 0 for empty store", async () => {
    const name = dbName();
    const setup = await openTestDb(name, [USERS_STORE]);
    setup.close();
    const emptyDriver = createIDBRuntimeDriver(name, 1).create();
    const emptyExecutor = new TestExecutor(emptyDriver);
    const contract = makeTestContract({ users: "User" }, { User: { storeName: "users", keyPath: "id" } });
    const client = asRecord(idbOrm({ contract, executor: emptyExecutor }));
    expect(await client["users"]!.count()).toBe(0);
    await emptyDriver.close();
  });

  it("returns 0 when filter matches nothing", async () => {
    const client = makeClient();
    expect(await client["users"]!.where({ id: "nonexistent" }).count()).toBe(0);
  });
});
