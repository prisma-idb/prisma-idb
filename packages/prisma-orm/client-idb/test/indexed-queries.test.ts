/**
 * Queries on indexed fields and keys return the right rows.
 *
 * Covers the cases where an index lookup and an in-memory filter could
 * disagree: values that aren't valid IndexedDB keys (null, booleans, NaN,
 * objects, bigints, arrays with a bad element), overlapping OR branches,
 * conditions left over after the indexed one, and includes joined on an
 * indexed foreign key or a primary key. Which physical plan runs is pinned by
 * `plan-shape-gate.test.ts`, not here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm, or, and } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbStoreAccessor } from "../src/exports/orm";

// ── Helpers ───────────────────────────────────────────────────────────────────

function asRecord(client: unknown): Record<string, IdbStoreAccessor<never, never>> {
  return client as Record<string, IdbStoreAccessor<never, never>>;
}

class TestExecutor implements IdbQueryExecutor {
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
}

let dbCounter = 0;
const dbName = () => `indexed-queries-test-${++dbCounter}`;

type StoreIndex = { name: string; keyPath: string; unique?: boolean };
type StoreSpec = { name: string; keyPath: string; indexes?: StoreIndex[] };

function openTestDb(name: string, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const spec of stores) {
        const os = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
        for (const idx of spec.indexes ?? []) {
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
    const os = tx.objectStore(storeName);
    for (const r of records) os.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Contracts ─────────────────────────────────────────────────────────────────

const userContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String", email: "String", active: "Boolean" },
      indexes: { byEmail: { keyPath: "email", unique: true } },
    },
  },
});

const relContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      // No secondary index declared on `id`: the N:1 `Post.author` include
      // below joins on the store's own primary key.
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", title: "String", authorId: "String" },
      indexes: { byAuthorId: { keyPath: "authorId", unique: false } },
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
      },
    },
  },
});

const USERS_STORE: StoreSpec = {
  name: "users",
  keyPath: "id",
  indexes: [{ name: "byEmail", keyPath: "email", unique: true }],
};
const POSTS_STORE: StoreSpec = {
  name: "posts",
  keyPath: "id",
  indexes: [{ name: "byAuthorId", keyPath: "authorId" }],
};

const USERS = [
  { id: "u1", name: "Alice", email: "alice@example.com", active: true },
  { id: "u2", name: "Bob", email: "bob@example.com", active: false },
  { id: "u3", name: "Carol", email: "carol@example.com", active: true },
];

const POSTS = [
  { id: "p1", title: "Hello", authorId: "u1" },
  { id: "p2", title: "World", authorId: "u1" },
  { id: "p3", title: "Other", authorId: "u2" },
];

// ── Equality ──────────────────────────────────────────────────────────────────

describe("equality on indexed fields and keys", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [USERS_STORE]);
    await seedStore(db, "users", USERS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("returns correct rows for equality on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where({ email: "alice@example.com" }).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("returns correct rows for equality on the primary key", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where({ id: "u1" }).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("returns empty array when no record matches the indexed equality", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where({ email: "nobody@example.com" }).all().toArray();
    expect(rows).toEqual([]);
  });

  it("still applies remaining filters after indexed equality narrows the scan", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // email has an index; active does not — use shorthand form (avoids index-sig TS quirk on never)
    const rows = await client["users"]!.where({ email: "alice@example.com", active: false }).all().toArray();
    // Alice has active=true, so nothing should match
    expect(rows).toEqual([]);
  });

  it("returns correct rows for equality on a non-indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where({ name: "Alice" }).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("returns correct rows with take/skip on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Only one Alice, so take(1) should return her
    const rows = await client["users"]!.where({ email: "alice@example.com" }).take(1).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("does not throw for eq-null on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // `IDBKeyRange.only(null)` throws. The raw AST builder, unlike the
    // `.where({...})` shorthand, doesn't turn null into a null-check.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", null))
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });

  it("does not throw for a boolean eq value on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // `IDBKeyRange.only(true)` throws DataError. Use the raw AST builder so
    // the value is not normalised by the `.where({…})` shorthand.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", true))
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });

  it("does not throw for a NaN eq value on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // `IDBKeyRange.only(NaN)` throws DataError.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", NaN))
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });

  it("does not throw for a plain-object eq value on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // `IDBKeyRange.only({})` throws DataError.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", {}))
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });

  it("does not throw for a BigInt eq value on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // BigInt is a supported IDB scalar codec but not a valid IndexedDB key
    // type — IDBKeyRange.only(1n) throws DataError.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", 1n))
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });

  it("does not throw for an array eq value containing an invalid element", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Arrays are valid IDB keys, but only when every element is itself a
    // valid key — IDBKeyRange.only(["a", true]) throws DataError because of
    // the nested boolean.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", ["a", true]))
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });
});

// ── include() ─────────────────────────────────────────────────────────────────

describe("include() joined on an indexed foreign key or a primary key", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [{ name: "users", keyPath: "id" }, POSTS_STORE]);
    await seedStore(db, "users", [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ]);
    await seedStore(db, "posts", POSTS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("loads relation correctly when FK has an index (single parent)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor }));
    const rows = (await client["users"]!.where({ id: "u1" }).include("posts").all().toArray()) as unknown as Array<{
      id: string;
      posts: Array<{ id: string; title: string; authorId: string }>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.posts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("loads relation correctly when FK has an index (multiple parents)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor }));
    const rows = (await client["users"]!.include("posts").all().toArray()) as unknown as Array<{
      id: string;
      posts: Array<{ id: string }>;
    }>;
    const alice = rows.find((r) => r.id === "u1")!;
    const bob = rows.find((r) => r.id === "u2")!;
    expect(alice.posts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(bob.posts.map((p) => p.id).sort()).toEqual(["p3"]);
  });

  it("loads an N:1 relation whose target is the related store's primary key", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor }));
    const rows = (await client["posts"]!.include("author").all().toArray()) as unknown as Array<{
      id: string;
      author: { id: string } | null;
    }>;
    expect(rows.map((r) => [r.id, r.author?.id])).toEqual([
      ["p1", "u1"],
      ["p2", "u1"],
      ["p3", "u2"],
    ]);
  });

  it("does not throw for an FK value that isn't a valid key (N:1 include)", async () => {
    // authorId isn't a key on `posts`, so it can hold malformed data that
    // would throw DataError if handed straight to IDBKeyRange.only() against
    // `users`' primary key.
    const name = dbName();
    const localDb = await openTestDb(name, [{ name: "users", keyPath: "id" }, POSTS_STORE]);
    await seedStore(localDb, "users", [{ id: "u1", name: "Alice" }]);
    await seedStore(localDb, "posts", [
      { id: "p1", title: "Hello", authorId: "u1" },
      { id: "p9", title: "Orphan", authorId: true },
    ]);
    localDb.close();
    const localDriver = createIDBRuntimeDriver(name, 1).create();
    const localExecutor = new TestExecutor(localDriver);
    const client = asRecord(idbOrm({ contract: relContract, executor: localExecutor }));

    const rows = (await client["posts"]!.include("author").all().toArray()) as unknown as Array<{
      id: string;
      author: { id: string; name: string } | null;
    }>;

    expect(rows.find((r) => r.id === "p1")!.author).toEqual({ id: "u1", name: "Alice" });
    expect(rows.find((r) => r.id === "p9")!.author).toBeNull();

    await localDriver.close();
  });
});

// ── Nested AND ────────────────────────────────────────────────────────────────

describe("nested AND", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [USERS_STORE]);
    await seedStore(db, "users", USERS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("matches an indexed eq field inside a nested AND", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Build AND(AND(email=x, active=true)) explicitly.
    const rows = await client["users"]!.where(() =>
      and(and(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("active", "eq", true)))
    )
      .all()
      .toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("still applies the non-indexed condition after flattening", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Alice's email matches but active=false does not — should return nothing.
    const rows = await client["users"]!.where(() =>
      and(and(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("active", "eq", false)))
    )
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });
});

// ── OR ────────────────────────────────────────────────────────────────────────

describe("OR on indexed fields", () => {
  let driver: IdbRuntimeDriverInstance;
  let executor: TestExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [USERS_STORE]);
    await seedStore(db, "users", USERS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    executor = new TestExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("returns correct rows for OR on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "bob@example.com"))
    )
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  it("deduplicates rows when OR branches overlap", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Both branches match Alice — result must contain her exactly once.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "alice@example.com"))
    )
      .all()
      .toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe("u1");
  });

  it("returns correct rows for an OR on the primary key", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where(() => or(fieldFilter("id", "eq", "u1"), fieldFilter("id", "eq", "u2")))
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  it("applies remaining AND conditions after the OR union", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Alice (active=true) and Bob (active=false) both match the OR on email;
    // the AND wrapping the OR should exclude Bob.
    const rows = await client["users"]!.where(() =>
      and(
        or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "bob@example.com")),
        fieldFilter("active", "eq", true)
      )
    )
      .all()
      .toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe("u1");
  });

  it("preserves residual filters and pagination around a nested indexed OR", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where(() =>
      and(
        and(
          or(
            fieldFilter("email", "eq", "carol@example.com"),
            fieldFilter("email", "eq", "bob@example.com"),
            fieldFilter("email", "eq", "alice@example.com")
          )
        ),
        and(fieldFilter("active", "eq", true))
      )
    )
      .orderBy({ name: "asc" })
      .skip(1)
      .take(1)
      .select("name")
      .all()
      .toArray();
    expect(rows).toEqual([{ name: "Carol" }]);
  });

  it("returns correct rows when one OR branch is on a non-indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("name", "eq", "Bob"))
    )
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  it("applies orderBy before take/skip", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // The first branch matches Carol, so a union in branch order must be
    // re-sorted before take(1), or this would return Carol.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "carol@example.com"), fieldFilter("email", "eq", "alice@example.com"))
    )
      .orderBy({ name: "asc" })
      .take(1)
      .all()
      .toArray();
    expect((rows as { name: string }[]).map((r) => r.name)).toEqual(["Alice"]);
  });

  it("does not throw for an eq-null OR branch on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // `IDBKeyRange.only(null)` throws.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", null))
    )
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["u1"]);
  });

  it("applies skip and take to count() with an OR", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor }));
    // Three users total (Alice, Bob, Carol). OR matches Alice + Bob → 2 rows.
    // skip(1) → 1 | take(1) → cap at 1 → count should be 1.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "bob@example.com"))
    )
      .skip(1)
      .take(1)
      .count();
    expect(rows).toBe(1);
  });
});
