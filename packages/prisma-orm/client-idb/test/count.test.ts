/**
 * `count()` and count-only `aggregate()`.
 *
 * Every case checks `count()` against `all().toArray().length` for the same
 * query as well as against a hand-written number, so a count that takes a
 * different physical path than the rows can't drift from them. The fixture
 * covers the values an index can't count correctly: nulls (absent from an
 * index), a multiEntry index (one row, several entries), residual filters and
 * overlapping OR branches. Which physical plan runs is pinned by
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
import { idbOrm, or } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbStoreAccessor } from "../src/exports/orm";

// ── Helpers ───────────────────────────────────────────────────────────────────

type Accessor = IdbStoreAccessor<never, never>;

function asRecord(client: unknown): Record<string, Accessor> {
  return client as Record<string, Accessor>;
}

type CapturedPlan = IdbQueryPlan<Record<string, unknown>>;

class SpyExecutor implements IdbQueryExecutor {
  captured: CapturedPlan[] = [];
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

  reset(): void {
    this.captured = [];
  }
}

let dbCounter = 0;
const dbName = () => `count-test-${++dbCounter}`;

type StoreIndex = { name: string; keyPath: string | string[]; unique?: boolean; multiEntry?: boolean };
type StoreSpec = { name: string; keyPath: string | string[]; indexes?: StoreIndex[] };

function openTestDb(name: string, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const spec of stores) {
        const os = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
        for (const idx of spec.indexes ?? []) {
          os.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false, multiEntry: idx.multiEntry ?? false });
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: {
        id: "String",
        category: "String",
        note: "String?",
        score: "Int",
        when: "DateTime",
        tags: "Json",
      },
      indexes: {
        byCategory: { keyPath: "category", unique: false },
        byNote: { keyPath: "note", unique: false },
        byWhen: { keyPath: "when", unique: false },
        byTags: { keyPath: "tags", unique: false, multiEntry: true },
      },
    },
    Membership: {
      store: "memberships",
      key: ["orgId", "userId"],
      fields: { orgId: "String", userId: "String", role: "String" },
    },
  },
});

const ITEMS_STORE: StoreSpec = {
  name: "items",
  keyPath: "id",
  indexes: [
    { name: "byCategory", keyPath: "category" },
    { name: "byNote", keyPath: "note" },
    { name: "byWhen", keyPath: "when" },
    { name: "byTags", keyPath: "tags", multiEntry: true },
  ],
};
const MEMBERSHIPS_STORE: StoreSpec = { name: "memberships", keyPath: ["orgId", "userId"] };

const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-02-01T00:00:00Z");
const T3 = new Date("2026-03-01T00:00:00Z");

// 10 items: category a×4, b×3, c×3; two share `when: T1`; `note` is null on 6.
const ITEMS = [
  { id: "i1", category: "a", note: "n", score: 1, when: T1, tags: ["x", "y"] },
  { id: "i2", category: "a", note: null, score: 2, when: T1, tags: ["x"] },
  { id: "i3", category: "a", note: null, score: 3, when: T2, tags: [] },
  { id: "i4", category: "a", note: "n", score: 4, when: T2, tags: ["y"] },
  { id: "i5", category: "b", note: null, score: 5, when: T2, tags: ["x", "y", "z"] },
  { id: "i6", category: "b", note: null, score: 6, when: T3, tags: [] },
  { id: "i7", category: "b", note: "m", score: 7, when: T3, tags: ["z"] },
  { id: "i8", category: "c", note: null, score: 8, when: T3, tags: ["x"] },
  { id: "i9", category: "c", note: "m", score: 9, when: T3, tags: [] },
  { id: "i10", category: "c", note: null, score: 10, when: T3, tags: ["y"] },
];

const MEMBERSHIPS = [
  { orgId: "o1", userId: "u1", role: "admin" },
  { orgId: "o1", userId: "u2", role: "member" },
  { orgId: "o2", userId: "u1", role: "member" },
];

// ── count() ───────────────────────────────────────────────────────────────────

describe("count()", () => {
  let driver: IdbRuntimeDriverInstance;
  let spy: SpyExecutor;
  let items: Accessor;
  let memberships: Accessor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [ITEMS_STORE, MEMBERSHIPS_STORE]);
    await seedStore(db, "items", ITEMS);
    await seedStore(db, "memberships", MEMBERSHIPS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    spy = new SpyExecutor(driver);
    const client = asRecord(idbOrm({ contract, executor: spy }));
    items = client["items"]!;
    memberships = client["memberships"]!;
  });

  afterEach(async () => {
    await driver.close();
  });

  /**
   * Runs `count()` and the equivalent `all().toArray()` for the same query and
   * asserts they agree and equal `expected`.
   */
  async function check(
    build: (a: Accessor) => Accessor,
    expected: number,
    accessor: () => Accessor = () => items
  ): Promise<void> {
    const n = await build(accessor()).count();
    const rows = await build(accessor()).all().toArray();
    expect(n).toBe(rows.length);
    expect(n).toBe(expected);
  }

  it("counts a whole store when there is no where()", async () => {
    await check((a) => a, 10);
  });

  it("counts equality on the primary key", async () => {
    await check((a) => a.where({ id: "i3" }), 1);
    await check((a) => a.where({ id: "nope" }), 0);
  });

  it("counts equality on an indexed field", async () => {
    await check((a) => a.where({ category: "a" }), 4);
    await check((a) => a.where({ category: "b" }), 3);
    await check((a) => a.where({ category: "zzz" }), 0);
  });

  it("counts equality on an indexed Date field by value", async () => {
    await check((a) => a.where({ when: T1 }), 2);
    await check((a) => a.where({ when: new Date("2026-03-01T00:00:00Z") }), 5);
  });

  it("ignores orderBy", async () => {
    await check((a) => a.where({ category: "a" }).orderBy({ score: "desc" }), 4);
    await check((a) => a.orderBy({ score: "asc" }), 10);
  });

  describe("skip / take apply to the matching rows", () => {
    it("skip", async () => {
      await check((a) => a.where({ category: "a" }).skip(1), 3);
      await check((a) => a.skip(4), 6);
    });
    it("take", async () => {
      await check((a) => a.where({ category: "a" }).take(2), 2);
      await check((a) => a.take(3), 3);
    });
    it("skip + take", async () => {
      await check((a) => a.where({ category: "a" }).skip(1).take(2), 2);
      await check((a) => a.where({ category: "a" }).skip(3).take(5), 1);
    });
    it("take larger than the total is capped at the total", async () => {
      await check((a) => a.where({ category: "b" }).take(100), 3);
    });
    it("skip beyond the total gives 0, never negative", async () => {
      await check((a) => a.where({ category: "a" }).skip(50), 0);
      await check((a) => a.skip(50).take(5), 0);
    });
    it("take(0) gives 0", async () => {
      await check((a) => a.where({ category: "a" }).take(0), 0);
    });
  });

  describe("values an index can't count by itself", () => {
    it("equality on an unindexed field (in-memory filter)", async () => {
      await check((a) => a.where({ score: 7 }), 1);
    });

    it("indexed equality plus a condition on another field", async () => {
      await check((a) => a.where({ category: "a", score: 4 }), 1);
      await check((a) => a.where({ category: "a", score: 999 }), 0);
    });

    it("an eq-null on an indexed nullable field (null is not a valid IDB key)", async () => {
      // Rows with a null `note` are absent from `byNote`, and null isn't a
      // valid key, so `index.count(only(null))` would throw DataError.
      await check((a) => a.where({ note: null }), 6);
    });

    it("a multiEntry-indexed field", async () => {
      // One record can occupy several multiEntry index entries, so counting
      // index entries would over-count.
      await check((a) => a.where({ tags: "x" }), 0);
    });

    it("overlapping OR branches (a per-branch count would count a row twice)", async () => {
      // i1 is in category "a" AND is the id branch → per-branch counting gives 5.
      const n = await items.where(() => or(fieldFilter("category", "eq", "a"), fieldFilter("id", "eq", "i1"))).count();
      expect(n).toBe(4);
    });

    it("OR honours skip/take", async () => {
      const n = await items
        .where(() => or(fieldFilter("category", "eq", "a"), fieldFilter("category", "eq", "b")))
        .skip(2)
        .take(3)
        .count();
      expect(n).toBe(3);
    });
  });

  describe("compound primary key", () => {
    it("counts a whole compound-keyed store", async () => {
      await check(
        (a) => a,
        3,
        () => memberships
      );
    });

    it("equality on one member of a compound key", async () => {
      await check(
        (a) => a.where({ orgId: "o1" }),
        2,
        () => memberships
      );
      await check(
        (a) => a.where({ userId: "u1" }),
        2,
        () => memberships
      );
    });

    it("equality on every member of a compound key", async () => {
      await check(
        (a) => a.where({ orgId: "o1", userId: "u2" }),
        1,
        () => memberships
      );
    });
  });

  it("emits a `count` AST for middleware", async () => {
    spy.reset();
    await items.where({ category: "a" }).count();
    expect(spy.captured[0]!.ast?.kind).toBe("count");
    spy.reset();
    await items.where({ score: 7 }).count();
    expect(spy.captured[0]!.ast?.kind).toBe("count");
  });

  it("a count over an empty store is 0", async () => {
    const name = dbName();
    const db = await openTestDb(name, [ITEMS_STORE]);
    db.close();
    const emptyDriver = createIDBRuntimeDriver(name, 1).create();
    const client = asRecord(idbOrm({ contract, executor: new SpyExecutor(emptyDriver) }));
    expect(await client["items"]!.count()).toBe(0);
    expect(await client["items"]!.where({ category: "a" }).count()).toBe(0);
    await emptyDriver.close();
  });
});

// ── aggregate() with count as the only selector ───────────────────────────────

describe("aggregate() with count selectors", () => {
  let driver: IdbRuntimeDriverInstance;
  let spy: SpyExecutor;
  let items: Accessor;

  beforeEach(async () => {
    const name = dbName();
    const db = await openTestDb(name, [ITEMS_STORE, MEMBERSHIPS_STORE]);
    await seedStore(db, "items", ITEMS);
    db.close();
    driver = createIDBRuntimeDriver(name, 1).create();
    spy = new SpyExecutor(driver);
    items = asRecord(idbOrm({ contract, executor: spy }))["items"]!;
  });

  afterEach(async () => {
    await driver.close();
  });

  it("counts a whole store, emitting an `aggregate` AST for middleware", async () => {
    const res = await items.aggregate((agg) => ({ total: agg.count() }));
    expect(res).toEqual({ total: 10 });
    expect(spy.captured[0]!.ast?.kind).toBe("aggregate");
  });

  it("counts indexed equality", async () => {
    const res = await items.where({ category: "a" }).aggregate((agg) => ({ n: agg.count() }));
    expect(res).toEqual({ n: 4 });
  });

  it("gives every count alias the same total", async () => {
    const res = await items.aggregate((agg) => ({ a: agg.count(), b: agg.count() }));
    expect(res).toEqual({ a: 10, b: 10 });
  });

  it("a mixed spec (count + sum)", async () => {
    const res = await items.aggregate((agg) => ({ n: agg.count(), total: agg.sum("score") }));
    expect(res).toEqual({ n: 10, total: 55 });
  });

  it("equality on an unindexed field", async () => {
    const res = await items.where({ score: 7 }).aggregate((agg) => ({ n: agg.count() }));
    expect(res).toEqual({ n: 1 });
  });

  it("ignores skip/take, with or without other selectors", async () => {
    const countOnly = await items
      .where({ category: "b" })
      .skip(1)
      .take(1)
      .aggregate((agg) => ({ n: agg.count() }));
    const mixed = await items
      .where({ category: "b" })
      .skip(1)
      .take(1)
      .aggregate((agg) => ({ n: agg.count(), s: agg.sum("score") }));
    expect(countOnly.n).toBe(3);
    expect(countOnly.n).toBe(mixed.n);
  });

  it("an empty match gives 0, not null", async () => {
    const res = await items.where({ category: "zzz" }).aggregate((agg) => ({ n: agg.count() }));
    expect(res).toEqual({ n: 0 });
  });
});
