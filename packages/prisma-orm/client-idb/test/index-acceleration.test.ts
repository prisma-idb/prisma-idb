/**
 * Index-acceleration tests.
 *
 * Verifies that equality queries on indexed fields use the IDB index instead of
 * a full cursor scan, and that relation includes use indexes for the FK join.
 *
 * Two layers of assertions:
 *  1. Correctness — returned rows match expectations regardless of scan strategy.
 *  2. Plan inspection — the idbPlan actually uses a cursor-scan with indexName
 *     rather than a full store scan.
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

type CapturedPlan = IdbQueryPlan<Record<string, unknown>>;

class SpyExecutor implements IdbQueryExecutor {
  readonly captured: CapturedPlan[] = [];
  readonly #driver: IdbRuntimeDriverInstance;

  constructor(driver: IdbRuntimeDriverInstance) {
    this.#driver = driver;
  }

  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    this.captured.push(plan as unknown as CapturedPlan);
    const iterable = this.#driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of iterable) yield row as Row;
      })()
    );
  }
}

let dbCounter = 0;
const dbName = () => `index-accel-test-${++dbCounter}`;

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
      // No secondary index declared on `id` — the N:1 `Post.author` include
      // below relies on the relation loader recognizing the store's own
      // primary key as point-range-queryable without a named index.
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

// ── Main query index acceleration ─────────────────────────────────────────────

describe("index-accelerated equality — main query", () => {
  let driver: IdbRuntimeDriverInstance;
  let spy: SpyExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [USERS_STORE]);
    await seedStore(db, "users", USERS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    spy = new SpyExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("returns correct rows for equality on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    const rows = await client["users"]!.where({ email: "alice@example.com" }).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("uses cursor-scan with indexName for equality on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    await client["users"]!.where({ email: "alice@example.com" }).all().toArray();
    const plan = spy.captured[0]!.idbPlan;
    expect(plan.kind).toBe("cursor-scan");
    expect((plan as { indexName?: string }).indexName).toBe("byEmail");
  });

  it("uses a point-range scan against the store's own keyPath for equality on the primary key (no named index needed)", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    const rows = await client["users"]!.where({ id: "u1" }).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);

    const plan = spy.captured[0]!.idbPlan as { indexName?: string; range?: IDBKeyRange };
    // `id` is the store's own keyPath — no secondary index is declared on it,
    // but it must still resolve to a point-range scan, not a full-store scan.
    expect(plan.indexName).toBeUndefined();
    expect(plan.range).toBeDefined();
    expect(plan.range!.lower).toEqual(plan.range!.upper);
    expect(plan.range!.lower).toBe("u1");
  });

  it("returns empty array when no record matches the indexed equality", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    const rows = await client["users"]!.where({ email: "nobody@example.com" }).all().toArray();
    expect(rows).toEqual([]);
  });

  it("still applies remaining filters after indexed equality narrows the scan", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // email has an index; active does not — use shorthand form (avoids index-sig TS quirk on never)
    const rows = await client["users"]!.where({ email: "alice@example.com", active: false }).all().toArray();
    // Alice has active=true, so nothing should match
    expect(rows).toEqual([]);
  });

  it("uses index plan even when combined with a non-indexed filter", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    await client["users"]!.where({ email: "alice@example.com", active: false }).all().toArray();
    const plan = spy.captured[0]!.idbPlan;
    expect(plan.kind).toBe("cursor-scan");
    expect((plan as { indexName?: string }).indexName).toBe("byEmail");
  });

  it("falls back to full cursor-scan for equality on non-indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    await client["users"]!.where({ name: "Alice" }).all().toArray();
    const plan = spy.captured[0]!.idbPlan;
    expect(plan.kind).toBe("cursor-scan");
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("returns correct rows with take/skip on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // Only one Alice, so take(1) should return her
    const rows = await client["users"]!.where({ email: "alice@example.com" }).take(1).all().toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
  });

  it("does not crash and falls back to full scan for eq-null on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // `IDBKeyRange.only(null)` throws — the raw AST builder (unlike the
    // `.where({...})` shorthand, which converts null to a null-check) must
    // not hand a null eq value to the index-acceleration path.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", null))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("falls back to full scan without throwing for a boolean eq value", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // `IDBKeyRange.only(true)` throws DataError. The index-acceleration gate
    // must reject non-key-valid values so they fall back to a full scan.
    // Use the raw AST builder so the value is not normalised by the
    // `.where({…})` shorthand.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", true))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("falls back to full scan without throwing for a NaN eq value", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // `IDBKeyRange.only(NaN)` throws DataError.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", NaN))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("falls back to full scan without throwing for a plain-object eq value", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // `IDBKeyRange.only({})` throws DataError.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", {}))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("falls back to full scan without throwing for a BigInt eq value", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // BigInt is a supported IDB scalar codec but not a valid IndexedDB key
    // type — IDBKeyRange.only(1n) throws DataError.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", 1n))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("falls back to full scan without throwing for an array eq value containing an invalid element", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // Arrays are valid IDB keys, but only when every element is itself a
    // valid key — IDBKeyRange.only(["a", true]) throws DataError because of
    // the nested boolean. Key validation must recurse into array elements,
    // not just accept any array wholesale.
    const rows = await client["users"]!.where(() => fieldFilter("email", "eq", ["a", true]))
      .all()
      .toArray();
    expect(rows).toEqual([]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBeUndefined();
  });
});

// ── Relation-include index acceleration ───────────────────────────────────────

describe("index-accelerated include — relation loader", () => {
  let driver: IdbRuntimeDriverInstance;
  let spy: SpyExecutor;

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
    spy = new SpyExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("loads relation correctly when FK has an index (single parent)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor: spy }));
    const rows = (await client["users"]!.where({ id: "u1" }).include("posts").all().toArray()) as unknown as Array<{
      id: string;
      posts: Array<{ id: string; title: string; authorId: string }>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.posts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("uses indexed cursor-scan for the FK join when index exists (single parent)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor: spy }));
    await client["users"]!.where({ id: "u1" }).include("posts").all().toArray();
    // The second plan (after the user scan) should be the posts include scan
    const includesPlan = spy.captured.find((p) => (p.idbPlan as { storeName?: string }).storeName === "posts");
    expect(includesPlan).toBeDefined();
    expect((includesPlan!.idbPlan as { indexName?: string }).indexName).toBe("byAuthorId");
  });

  it("loads relation correctly when FK has an index (multiple parents)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor: spy }));
    const rows = (await client["users"]!.include("posts").all().toArray()) as unknown as Array<{
      id: string;
      posts: Array<{ id: string }>;
    }>;
    const alice = rows.find((r) => r.id === "u1")!;
    const bob = rows.find((r) => r.id === "u2")!;
    expect(alice.posts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(bob.posts.map((p) => p.id).sort()).toEqual(["p3"]);
  });

  it("uses one indexed point-range scan per distinct FK value (not a bound-range)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor: spy }));
    await client["users"]!.include("posts").all().toArray();
    const postPlans = spy.captured.filter((p) => (p.idbPlan as { storeName?: string }).storeName === "posts");
    // Two distinct authorId values (u1, u2) → two separate point-range scans.
    expect(postPlans).toHaveLength(2);
    for (const plan of postPlans) {
      expect((plan.idbPlan as { indexName?: string }).indexName).toBe("byAuthorId");
      const range = (plan.idbPlan as { range?: IDBKeyRange }).range;
      // Each scan is a point range (lower === upper), not a bound range.
      expect(range).toBeDefined();
      expect(range!.lower).toEqual(range!.upper);
    }
  });

  it("uses a point-range scan against the store's own keyPath for a PK-target FK (no named index needed)", async () => {
    const client = asRecord(idbOrm({ contract: relContract, executor: spy }));
    await client["posts"]!.include("author").all().toArray();
    const authorPlans = spy.captured.filter((p) => (p.idbPlan as { storeName?: string }).storeName === "users");
    // Two distinct authorId values in POSTS (u1, u2) → two point-range scans,
    // NOT one full-store scan with an in-memory membership filter — an FK
    // pointing at another store's PK must stay O(log N) per lookup, same as
    // an FK pointing at a named secondary index.
    expect(authorPlans).toHaveLength(2);
    for (const plan of authorPlans) {
      const idbPlan = plan.idbPlan as { indexName?: string; range?: IDBKeyRange; filter?: unknown };
      // No named index — `users.id` is the store's own keyPath.
      expect(idbPlan.indexName).toBeUndefined();
      // But it's still a point-range scan, not a full-store filter scan.
      expect(idbPlan.range).toBeDefined();
      expect(idbPlan.range!.lower).toEqual(idbPlan.range!.upper);
    }
  });

  it("falls back for an invalid FK value instead of throwing (indexed N:1 include)", async () => {
    // authorId isn't a key on `posts` (only a regular field), so it can hold
    // malformed data that would throw DataError if handed straight to
    // IDBKeyRange.only() on the point-range scan against `users`' own keyPath.
    const name = dbName();
    const localDb = await openTestDb(name, [{ name: "users", keyPath: "id" }, POSTS_STORE]);
    await seedStore(localDb, "users", [{ id: "u1", name: "Alice" }]);
    await seedStore(localDb, "posts", [
      { id: "p1", title: "Hello", authorId: "u1" },
      { id: "p9", title: "Orphan", authorId: true },
    ]);
    localDb.close();
    const localDriver = createIDBRuntimeDriver(name, 1).create();
    const localSpy = new SpyExecutor(localDriver);
    const client = asRecord(idbOrm({ contract: relContract, executor: localSpy }));

    const rows = (await client["posts"]!.include("author").all().toArray()) as unknown as Array<{
      id: string;
      author: { id: string; name: string } | null;
    }>;

    expect(rows.find((r) => r.id === "p1")!.author).toEqual({ id: "u1", name: "Alice" });
    expect(rows.find((r) => r.id === "p9")!.author).toBeNull();

    await localDriver.close();
  });
});

// ── Nested AND index acceleration ─────────────────────────────────────────────

describe("index acceleration — nested AND flattening", () => {
  let driver: IdbRuntimeDriverInstance;
  let spy: SpyExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [USERS_STORE]);
    await seedStore(db, "users", USERS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    spy = new SpyExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("uses index when the indexed eq field is inside a nested AND", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // Build AND(AND(email=x, active=true)) explicitly to exercise flattenAnd.
    const rows = await client["users"]!.where(() =>
      and(and(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("active", "eq", true)))
    )
      .all()
      .toArray();
    expect(rows).toEqual([{ id: "u1", name: "Alice", email: "alice@example.com", active: true }]);
    const plan = spy.captured[0]!.idbPlan;
    expect((plan as { indexName?: string }).indexName).toBe("byEmail");
  });

  it("still applies the non-indexed condition after flattening", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // Alice's email matches but active=false does not — should return nothing.
    const rows = await client["users"]!.where(() =>
      and(and(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("active", "eq", false)))
    )
      .all()
      .toArray();
    expect(rows).toEqual([]);
  });
});

// ── OR index acceleration ─────────────────────────────────────────────────────

describe("index acceleration — OR multi-scan", () => {
  let driver: IdbRuntimeDriverInstance;
  let spy: SpyExecutor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [USERS_STORE]);
    await seedStore(db, "users", USERS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    spy = new SpyExecutor(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("returns correct rows for OR on indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "bob@example.com"))
    )
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  it("deduplicates rows when OR branches overlap", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // Both branches match Alice — result must contain her exactly once.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "alice@example.com"))
    )
      .all()
      .toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe("u1");
  });

  it("fires one indexed scan per OR branch", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", "bob@example.com"))
    )
      .all()
      .toArray();
    const userPlans = spy.captured.filter((p) => (p.idbPlan as { storeName?: string }).storeName === "users");
    expect(userPlans).toHaveLength(2);
    for (const plan of userPlans) {
      expect((plan.idbPlan as { indexName?: string }).indexName).toBe("byEmail");
    }
  });

  it("uses point-range scans against the store's own keyPath for an OR on the primary key", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    const rows = await client["users"]!.where(() => or(fieldFilter("id", "eq", "u1"), fieldFilter("id", "eq", "u2")))
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["u1", "u2"]);

    const userPlans = spy.captured.filter((p) => (p.idbPlan as { storeName?: string }).storeName === "users");
    expect(userPlans).toHaveLength(2);
    for (const plan of userPlans) {
      const idbPlan = plan.idbPlan as { indexName?: string; range?: IDBKeyRange };
      expect(idbPlan.indexName).toBeUndefined();
      expect(idbPlan.range).toBeDefined();
      expect(idbPlan.range!.lower).toEqual(idbPlan.range!.upper);
    }
  });

  it("applies remaining AND conditions after the OR union", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
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

  it("falls back to full scan when any OR branch lacks an index", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // `name` has no index — OR cannot be fully accelerated, must full-scan.
    await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("name", "eq", "Bob"))
    )
      .all()
      .toArray();
    const userPlans = spy.captured.filter((p) => (p.idbPlan as { storeName?: string }).storeName === "users");
    expect(userPlans).toHaveLength(1);
    expect((userPlans[0]!.idbPlan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("applies orderBy to the deduplicated union before take/skip", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // Union is produced in branch order (Carol, then Alice) — orderBy must
    // re-sort before take(1) picks the first row, or this would wrongly
    // return Carol.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "carol@example.com"), fieldFilter("email", "eq", "alice@example.com"))
    )
      .orderBy({ name: "asc" })
      .take(1)
      .all()
      .toArray();
    expect((rows as { name: string }[]).map((r) => r.name)).toEqual(["Alice"]);
  });

  it("does not crash and falls back to full scan for an eq-null branch on an indexed field", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
    // `IDBKeyRange.only(null)` throws — a null-valued OR branch on an indexed
    // field must not be accelerated.
    const rows = await client["users"]!.where(() =>
      or(fieldFilter("email", "eq", "alice@example.com"), fieldFilter("email", "eq", null))
    )
      .all()
      .toArray();
    expect((rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["u1"]);
    const userPlans = spy.captured.filter((p) => (p.idbPlan as { storeName?: string }).storeName === "users");
    expect(userPlans).toHaveLength(1);
    expect((userPlans[0]!.idbPlan as { indexName?: string }).indexName).toBeUndefined();
  });

  it("applies skip and take pagination to count() on the OR multi-scan path", async () => {
    const client = asRecord(idbOrm({ contract: userContract, executor: spy }));
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
