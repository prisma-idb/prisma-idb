/**
 * Phase 9.3 — native `count()` (`IdbCountPlan`).
 *
 * Two layers, like `index-acceleration.test.ts`:
 *  1. Correctness — `count()` must equal `all().toArray().length` for the same
 *     query on every path, native or not (a differential test, so a wrong
 *     fast path can't hide behind hand-written expected numbers).
 *  2. Plan inspection — a spy executor records the physical plan so the fast
 *     path can't silently regress to a cursor scan, and the fallbacks can't
 *     silently start using native count where it would be wrong.
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
import { clampCount, isNativelyCountable, toCountPlan } from "../src/core/query-shaping";

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
const dbName = () => `native-count-test-${++dbCounter}`;

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

// ── Native count: correctness + plan shape ────────────────────────────────────

describe("count() — native path", () => {
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
   * asserts (a) they agree, (b) the value is what's expected, and (c) the
   * physical plan the count issued was of the expected kind.
   */
  async function check(
    build: (a: Accessor) => Accessor,
    expected: { count: number; kind: "count" | "cursor-scan"; indexName?: string | undefined },
    accessor: () => Accessor = () => items
  ): Promise<void> {
    spy.reset();
    const n = await build(accessor()).count();
    const countPlans = spy.captured.map((p) => p.idbPlan);
    // A `count()` issues exactly the plans of its own path — never mixes kinds.
    expect(countPlans.every((p) => p.kind === expected.kind)).toBe(true);
    expect(countPlans.length).toBeGreaterThan(0);
    if (expected.indexName !== undefined) {
      expect((countPlans[0] as { indexName?: string }).indexName).toBe(expected.indexName);
    }
    const rows = await build(accessor()).all().toArray();
    expect(n).toBe(rows.length);
    expect(n).toBe(expected.count);
  }

  it("counts a whole store natively when there is no where()", async () => {
    await check((a) => a, { count: 10, kind: "count" });
    const plan = spy.captured[0]!.idbPlan as { range?: IDBKeyRange; indexName?: string };
    expect(plan.range).toBeUndefined();
    expect(plan.indexName).toBeUndefined();
  });

  it("counts natively for equality on the primary key (point range, no named index)", async () => {
    await check((a) => a.where({ id: "i3" }), { count: 1, kind: "count" });
    const plan = spy.captured[0]!.idbPlan as { range?: IDBKeyRange; indexName?: string };
    expect(plan.indexName).toBeUndefined();
    expect(plan.range!.lower).toBe("i3");
    await check((a) => a.where({ id: "nope" }), { count: 0, kind: "count" });
  });

  it("counts natively via the index for equality on an indexed field", async () => {
    await check((a) => a.where({ category: "a" }), { count: 4, kind: "count", indexName: "byCategory" });
    await check((a) => a.where({ category: "b" }), { count: 3, kind: "count", indexName: "byCategory" });
    await check((a) => a.where({ category: "zzz" }), { count: 0, kind: "count", indexName: "byCategory" });
  });

  it("counts natively on an indexed Date field (compares by value, consistent with findMany)", async () => {
    await check((a) => a.where({ when: T1 }), { count: 2, kind: "count", indexName: "byWhen" });
    await check((a) => a.where({ when: new Date("2026-03-01T00:00:00Z") }), {
      count: 5,
      kind: "count",
      indexName: "byWhen",
    });
  });

  it("does not disqualify native count because of orderBy", async () => {
    await check((a) => a.where({ category: "a" }).orderBy({ score: "desc" }), {
      count: 4,
      kind: "count",
      indexName: "byCategory",
    });
    await check((a) => a.orderBy({ score: "asc" }), { count: 10, kind: "count" });
  });

  describe("skip / take are applied after the native total", () => {
    it("skip", async () => {
      await check((a) => a.where({ category: "a" }).skip(1), { count: 3, kind: "count" });
      await check((a) => a.skip(4), { count: 6, kind: "count" });
    });
    it("take", async () => {
      await check((a) => a.where({ category: "a" }).take(2), { count: 2, kind: "count" });
      await check((a) => a.take(3), { count: 3, kind: "count" });
    });
    it("skip + take", async () => {
      await check((a) => a.where({ category: "a" }).skip(1).take(2), { count: 2, kind: "count" });
      await check((a) => a.where({ category: "a" }).skip(3).take(5), { count: 1, kind: "count" });
    });
    it("take larger than the total is capped at the total", async () => {
      await check((a) => a.where({ category: "b" }).take(100), { count: 3, kind: "count" });
    });
    it("skip beyond the total gives 0, never negative", async () => {
      await check((a) => a.where({ category: "a" }).skip(50), { count: 0, kind: "count" });
      await check((a) => a.skip(50).take(5), { count: 0, kind: "count" });
    });
    it("take(0) gives 0", async () => {
      await check((a) => a.where({ category: "a" }).take(0), { count: 0, kind: "count" });
    });
  });

  describe("falls back to materializing when native count would be wrong", () => {
    it("equality on an unindexed field (in-memory filter)", async () => {
      await check((a) => a.where({ score: 7 }), { count: 1, kind: "cursor-scan" });
    });

    it("indexed equality plus a residual condition (remainingFilter)", async () => {
      await check((a) => a.where({ category: "a", score: 4 }), {
        count: 1,
        kind: "cursor-scan",
        indexName: "byCategory",
      });
      await check((a) => a.where({ category: "a", score: 999 }), { count: 0, kind: "cursor-scan" });
    });

    it("an eq-null on an indexed nullable field (null is not a valid IDB key)", async () => {
      // Rows with a null `note` are absent from `byNote`; a native
      // `index.count(only(null))` would throw DataError, or wrongly say 0.
      await check((a) => a.where({ note: null }), { count: 6, kind: "cursor-scan" });
    });

    it("a multiEntry-indexed field is never routed to native count", async () => {
      // One record can occupy several multiEntry index entries, so an
      // entry count would over-count. The equality hint never selects it.
      await check((a) => a.where({ tags: "x" }), { count: 0, kind: "cursor-scan" });
    });

    it("the OR multi-scan path (a per-branch count would double-count overlaps)", async () => {
      spy.reset();
      // i1 is in category "a" AND is the id branch → naive per-branch counting gives 5.
      const n = await items.where(() => or(fieldFilter("category", "eq", "a"), fieldFilter("id", "eq", "i1"))).count();
      expect(n).toBe(4);
      expect(spy.captured.every((p) => p.idbPlan.kind !== "count")).toBe(true);
    });

    it("OR path still honours skip/take", async () => {
      const n = await items
        .where(() => or(fieldFilter("category", "eq", "a"), fieldFilter("category", "eq", "b")))
        .skip(2)
        .take(3)
        .count();
      expect(n).toBe(3);
    });
  });

  describe("compound primary key (Phase 9.1)", () => {
    it("counts a whole compound-keyed store natively", async () => {
      await check(
        (a) => a,
        { count: 3, kind: "count" },
        () => memberships
      );
    });

    it("equality on ONE member of a compound key is not a primary-key range — falls back, still correct", async () => {
      await check(
        (a) => a.where({ orgId: "o1" }),
        { count: 2, kind: "cursor-scan" },
        () => memberships
      );
      await check(
        (a) => a.where({ userId: "u1" }),
        { count: 2, kind: "cursor-scan" },
        () => memberships
      );
    });

    it("equality on every member is filter-evaluated (no compound-PK acceleration yet — Phase 10)", async () => {
      await check(
        (a) => a.where({ orgId: "o1", userId: "u2" }),
        { count: 1, kind: "cursor-scan" },
        () => memberships
      );
    });
  });

  it("emits a `count` AST for middleware regardless of the physical plan", async () => {
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

describe("aggregate() — count-only fast path", () => {
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

  const kinds = () => spy.captured.map((p) => p.idbPlan.kind);

  it("uses a native count for a whole store, keeping the aggregate AST for middleware", async () => {
    const res = await items.aggregate((agg) => ({ total: agg.count() }));
    expect(res).toEqual({ total: 10 });
    expect(kinds()).toEqual(["count"]);
    expect(spy.captured[0]!.ast?.kind).toBe("aggregate");
  });

  it("uses a native count for indexed equality", async () => {
    spy.reset();
    const res = await items.where({ category: "a" }).aggregate((agg) => ({ n: agg.count() }));
    expect(res).toEqual({ n: 4 });
    expect(kinds()).toEqual(["count"]);
    expect((spy.captured[0]!.idbPlan as { indexName?: string }).indexName).toBe("byCategory");
  });

  it("several count aliases share one native request", async () => {
    const res = await items.aggregate((agg) => ({ a: agg.count(), b: agg.count() }));
    expect(res).toEqual({ a: 10, b: 10 });
    expect(kinds()).toEqual(["count"]);
  });

  it("a mixed spec (count + sum) needs the rows, so it materializes", async () => {
    const res = await items.aggregate((agg) => ({ n: agg.count(), total: agg.sum("score") }));
    expect(res).toEqual({ n: 10, total: 55 });
    expect(kinds()).toEqual(["cursor-scan"]);
  });

  it("a residual in-memory filter falls back to materializing", async () => {
    const res = await items.where({ score: 7 }).aggregate((agg) => ({ n: agg.count() }));
    expect(res).toEqual({ n: 1 });
    expect(kinds()).toEqual(["cursor-scan"]);
  });

  it("matches the materialized result and ignores skip/take, exactly like the non-native path", async () => {
    const native = await items
      .where({ category: "b" })
      .skip(1)
      .take(1)
      .aggregate((agg) => ({ n: agg.count() }));
    const mixed = await items
      .where({ category: "b" })
      .skip(1)
      .take(1)
      .aggregate((agg) => ({ n: agg.count(), s: agg.sum("score") }));
    expect(native.n).toBe(3);
    expect(native.n).toBe(mixed.n);
  });

  it("an empty match gives 0, not null", async () => {
    const res = await items.where({ category: "zzz" }).aggregate((agg) => ({ n: agg.count() }));
    expect(res).toEqual({ n: 0 });
  });
});

// ── Unit tests: helpers ───────────────────────────────────────────────────────

describe("isNativelyCountable / toCountPlan / clampCount", () => {
  const META = { target: "idb", storageHash: "h", lane: "t" } as const;

  it("is countable only when there is no in-memory filter", () => {
    expect(isNativelyCountable({ meta: META, kind: "cursor-scan", storeName: "s" })).toBe(true);
    expect(isNativelyCountable({ meta: META, kind: "cursor-scan", storeName: "s", filter: () => true })).toBe(false);
  });

  it("ignores comparator, direction, skip and take", () => {
    expect(
      isNativelyCountable({
        meta: META,
        kind: "cursor-scan",
        storeName: "s",
        comparator: () => 0,
        direction: "prev",
        skip: 1,
        take: 2,
      })
    ).toBe(true);
  });

  it("toCountPlan carries store/index/range and drops everything else", () => {
    const range = IDBKeyRange.only("x");
    const plan = toCountPlan({
      meta: META,
      kind: "cursor-scan",
      storeName: "s",
      indexName: "byX",
      range,
      skip: 1,
      take: 2,
      comparator: () => 0,
    });
    expect(plan).toEqual({ meta: META, kind: "count", storeName: "s", indexName: "byX", range });
    expect(toCountPlan({ meta: META, kind: "cursor-scan", storeName: "s" })).toEqual({
      meta: META,
      kind: "count",
      storeName: "s",
    });
  });

  it("clampCount is exact arithmetic on the unpaginated total", () => {
    expect(clampCount(10, undefined, undefined)).toBe(10);
    expect(clampCount(10, 3, undefined)).toBe(7);
    expect(clampCount(10, undefined, 4)).toBe(4);
    expect(clampCount(10, 3, 4)).toBe(4);
    expect(clampCount(10, 8, 4)).toBe(2);
    expect(clampCount(10, 20, 4)).toBe(0);
    expect(clampCount(10, 0, 0)).toBe(0);
    expect(clampCount(0, 5, 5)).toBe(0);
  });
});
