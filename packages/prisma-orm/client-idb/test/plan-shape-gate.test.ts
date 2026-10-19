/**
 * Guards indexed paths against work that grows with the whole store.
 * Budgets count deserialized values plus keys at two fixture sizes. They allow
 * different IndexedDB request methods and planner implementations. Query and
 * mutation results are independently checked by planner-reads-differential.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import { and, or, idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";
import { installIdbProbe, type IdbProbe, type ProbeSnapshot } from "./_idb-probe";

// ── Fixture ───────────────────────────────────────────────────────────────────

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: { id: "String", category: "String", score: "Int", status: "String", orgId: "String", rank: "Int" },
      indexes: {
        byCategory: { keyPath: "category", unique: false },
        byScore: { keyPath: "score", unique: false },
        byOrgRank: { keyPath: ["orgId", "rank"], unique: false },
      },
    },
    ActivityPreference: {
      store: "activityPreferences",
      key: "id",
      fields: { id: "String", userId: "String", effectiveFrom: "DateTime" },
      indexes: { byUserEffective: { keyPath: ["userId", "effectiveFrom"], unique: true } },
    },
    Author: {
      store: "authors",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: { books: { to: "Book", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
    },
    Publisher: {
      store: "publishers",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: { books: { to: "Book", cardinality: "1:N", on: { local: ["id"], target: ["publisherId"] } } },
    },
    Book: {
      store: "books",
      key: "id",
      fields: { id: "String", authorId: "String", publisherId: "String", title: "String" },
      indexes: {
        byAuthor: { keyPath: "authorId", unique: false },
        byPublisher: { keyPath: "publisherId", unique: false },
      },
      relations: {
        author: { to: "Author", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] }, onDelete: "cascade" },
        publisher: { to: "Publisher", cardinality: "N:1", on: { local: ["publisherId"], target: ["id"] } },
      },
    },
  },
});

const SIZES = [100, 1000] as const;

const pad = (i: number) => String(i).padStart(4, "0");

/**
 * `n` items: 10 categories, scores `0..n-1`, two statuses, 5 orgs.
 * `n / 10` authors with 10 books each; every book belongs to publisher `p0`.
 * Publisher `p1` has no books.
 */
function seedRows(n: number): Record<string, Record<string, unknown>[]> {
  const authors = n / 10;
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: `item-${pad(i)}`,
      category: `c${i % 10}`,
      score: i,
      status: i % 2 === 0 ? "open" : "closed",
      orgId: `o${i % 5}`,
      rank: i,
    })),
    activityPreferences: Array.from({ length: n }, (_, i) => ({
      id: `preference-${pad(i)}`,
      userId: `u${i % 5}`,
      effectiveFrom: new Date(Math.floor(i / 5)),
    })),
    authors: Array.from({ length: authors }, (_, i) => ({ id: `a${pad(i)}`, name: `Author ${i}` })),
    publishers: [
      { id: "p0", name: "Busy" },
      { id: "p1", name: "Idle" },
    ],
    books: Array.from({ length: n }, (_, i) => ({
      id: `book-${pad(i)}`,
      authorId: `a${pad(i % authors)}`,
      publisherId: "p0",
      title: `Book ${i}`,
    })),
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

class TestExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
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

/** Creates every store and index the contract declares, then seeds `rows`. */
function openSeededDb(name: string, rows: Record<string, Record<string, unknown>[]>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [storeName, def] of Object.entries(contract.storage.stores)) {
        const store = db.createObjectStore(storeName, { keyPath: def.keyPath as string | string[] });
        for (const [indexName, idx] of Object.entries(def.indexes ?? {})) {
          store.createIndex(indexName, idx.keyPath as string | string[], {
            unique: idx.unique ?? false,
            multiEntry: idx.multiEntry ?? false,
          });
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(Object.keys(rows), "readwrite");
      for (const [storeName, records] of Object.entries(rows)) {
        const store = tx.objectStore(storeName);
        for (const record of records) store.put(record);
      }
      tx.oncomplete = () => resolve(db);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Loose view of the ORM: the gate exercises many shapes, and typing each one adds nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseOrm = Record<string, any>;

interface Scenario {
  readonly name: string;
  readonly run: (orm: LooseOrm, n: number) => Promise<unknown>;
}

const SCENARIOS: readonly Scenario[] = [
  // ── Single-store reads ──
  { name: "findMany: no filter", run: (o) => o["items"].all().toArray() },
  { name: "findMany: eq on primary key", run: (o) => o["items"].where({ id: "item-0003" }).all().toArray() },
  { name: "findUnique: primary key", run: (o) => o["items"].findUnique("item-0003") },
  { name: "findMany: eq on indexed field", run: (o) => o["items"].where({ category: "c3" }).all().toArray() },
  { name: "findMany: eq on non-indexed field", run: (o) => o["items"].where({ status: "open" }).all().toArray() },
  {
    name: "findMany: indexed eq AND non-indexed eq",
    run: (o) => o["items"].where({ category: "c3", status: "open" }).all().toArray(),
  },
  {
    name: "findMany: lt on indexed field",
    run: (o) =>
      o["items"]
        .where(() => fieldFilter("score", "lt", 20))
        .all()
        .toArray(),
  },
  {
    name: "findMany: gte AND lt on indexed field",
    run: (o) =>
      o["items"]
        .where(() => and(fieldFilter("score", "gte", 10), fieldFilter("score", "lt", 30)))
        .all()
        .toArray(),
  },
  {
    name: "findMany: in() on indexed field",
    run: (o) =>
      o["items"]
        .where(() => fieldFilter("category", "in", ["c1", "c2"]))
        .all()
        .toArray(),
  },
  {
    name: "findMany: OR of indexed eqs",
    run: (o) =>
      o["items"]
        .where(() => or(fieldFilter("category", "eq", "c1"), fieldFilter("category", "eq", "c2")))
        .all()
        .toArray(),
  },
  {
    name: "findMany: OR with an AND branch",
    run: (o) =>
      o["items"]
        .where(() =>
          or(
            and(fieldFilter("category", "eq", "c1"), fieldFilter("status", "eq", "closed")),
            fieldFilter("category", "eq", "c2")
          )
        )
        .all()
        .toArray(),
  },
  {
    name: "findMany: OR mixing indexed and non-indexed",
    run: (o) =>
      o["items"]
        .where(() => or(fieldFilter("category", "eq", "c1"), fieldFilter("status", "eq", "open")))
        .all()
        .toArray(),
  },
  {
    name: "findMany: compound index exact match",
    run: (o) => o["items"].where({ orgId: "o1", rank: 6 }).all().toArray(),
  },
  { name: "findMany: compound index prefix", run: (o) => o["items"].where({ orgId: "o1" }).all().toArray() },
  {
    name: "findMany: orderBy indexed field, take 10",
    run: (o) => o["items"].orderBy({ score: "asc" }).take(10).all().toArray(),
  },
  {
    name: "findMany: indexed in with orderBy and take 2",
    run: (o) =>
      o["items"]
        .where(() => fieldFilter("category", "in", ["c1", "c2"]))
        .orderBy({ category: "desc" })
        .take(2)
        .all()
        .toArray(),
  },
  {
    name: "findFirst: descending compound suffix",
    run: (o) => o["items"].where({ orgId: "o1" }).orderBy({ rank: "desc" }).first(),
  },
  {
    name: "findMany: compound suffix page with residual filter",
    run: (o) =>
      o["items"].where({ orgId: "o1", status: "closed" }).orderBy({ rank: "desc" }).skip(1).take(2).all().toArray(),
  },
  {
    name: "findFirst: descending Date history suffix",
    run: (o, n) =>
      o["activityPreferences"]
        .where(() => and(fieldFilter("userId", "eq", "u1"), fieldFilter("effectiveFrom", "lt", new Date(n / 10))))
        .orderBy({ effectiveFrom: "desc" })
        .first(),
  },
  { name: "findFirst: eq on indexed field", run: (o) => o["items"].where({ category: "c3" }).first() },
  { name: "count: no filter", run: (o) => o["items"].count() },
  { name: "count: eq on indexed field", run: (o) => o["items"].where({ category: "c3" }).count() },
  {
    name: "count: indexed eq AND non-indexed eq",
    run: (o) => o["items"].where({ category: "c3", status: "closed" }).count(),
  },
  {
    name: "count: in() on indexed field",
    run: (o) => o["items"].where(() => fieldFilter("category", "in", ["c1", "c2"])).count(),
  },
  {
    name: "count: lt on indexed field",
    run: (o) => o["items"].where(() => fieldFilter("score", "lt", 20)).count(),
  },
  {
    name: "aggregate: count and sum, eq on indexed field",
    run: (o) =>
      o["items"].where({ category: "c3" }).aggregate((a: LooseOrm) => ({ n: a["count"](), s: a["sum"]("score") })),
  },

  // ── Relation loading ──
  {
    name: "include 1:N via indexed foreign key",
    run: (o) => o["authors"].where({ id: "a0001" }).include("books").all().toArray(),
  },
  {
    name: "include N:1 via primary key",
    run: (o) => o["books"].where({ id: "book-0001" }).include("author").all().toArray(),
  },

  // ── Mutations ──
  {
    name: "create: foreign key validation",
    run: (o) => o["books"].create({ id: "book-new", authorId: "a0001", publisherId: "p0", title: "New" }),
  },
  { name: "delete: cascade to children via indexed foreign key", run: (o) => o["authors"].delete("a0001") },
  { name: "delete: restrict check, no children", run: (o) => o["publishers"].delete("p1") },
  {
    name: "updateAll: eq on indexed field",
    run: (o) => o["items"].where({ category: "c3" }).updateAll({ status: "archived" }).toArray(),
  },
  {
    name: "updateAll: range on indexed field",
    run: (o) =>
      o["items"]
        .where(() => fieldFilter("score", "lt", 20))
        .updateAll({ status: "archived" })
        .toArray(),
  },
  {
    name: "updateAll: changes walked index field",
    run: (o) => o["items"].where({ category: "c3" }).updateAll({ category: "c4" }).toArray(),
  },
  {
    name: "update: eq on indexed field",
    run: (o) => o["items"].where({ category: "c3" }).update({ status: "archived" }),
  },
  {
    name: "upsert: primary-key existing-row lookup",
    run: (o) =>
      o["items"].upsert({
        where: { id: "item-0003" },
        create: { id: "new", category: "new", score: 0, status: "active", orgId: "o1", rank: 0 },
        update: { status: "archived" },
      }),
  },
  {
    name: "deleteAll: eq on indexed field",
    run: (o) => o["items"].where({ category: "c3" }).deleteAll().toArray(),
  },
];

/** Maximum total values and keys read at each size in SIZES. */
const READ_BUDGETS: Record<string, readonly number[]> = {
  "findMany: eq on primary key": [2, 2],
  "findMany: eq on indexed field": [20, 200],
  "findMany: lt on indexed field": [24, 24],
  "findMany: in() on indexed field": [24, 240],
  "findMany: compound index exact match": [2, 2],
  "findMany: compound index prefix": [24, 240],
  "findMany: orderBy indexed field, take 10": [12, 12],
  "findFirst: descending compound suffix": [2, 2],
  "findMany: compound suffix page with residual filter": [8, 8],
  "findFirst: descending Date history suffix": [2, 2],
  "count: no filter": [0, 0],
  "count: eq on indexed field": [0, 0],
  "count: indexed eq AND non-indexed eq": [12, 120],
  "include 1:N via indexed foreign key": [16, 16],
  "create: foreign key validation": [4, 4],
  "delete: cascade to children via indexed foreign key": [28, 28],
  "delete: restrict check, no children": [4, 4],
  "updateAll: eq on indexed field": [12, 120],
  "updateAll: changes walked index field": [24, 240],
  "upsert: primary-key existing-row lookup": [4, 4],
  "findMany: no filter": [120, 1200],
  "findUnique: primary key": [2, 2],
  "findMany: eq on non-indexed field": [120, 1200],
  "findMany: indexed eq AND non-indexed eq": [12, 120],
  "findMany: gte AND lt on indexed field": [24, 24],
  "findMany: OR of indexed eqs": [24, 240],
  "findMany: OR with an AND branch": [120, 1200],
  "findMany: OR mixing indexed and non-indexed": [120, 1200],
  "findMany: indexed in with orderBy and take 2": [6, 6],
  "findFirst: eq on indexed field": [2, 2],
  "count: in() on indexed field": [0, 0],
  "count: lt on indexed field": [0, 0],
  "aggregate: count and sum, eq on indexed field": [12, 120],
  "include N:1 via primary key": [4, 4],
  "updateAll: range on indexed field": [24, 24],
  "update: eq on indexed field": [4, 4],
  "deleteAll: eq on indexed field": [24, 240],
};

let dbCounter = 0;

/** Measures storage reads at each size, with matching rows proportional to the store. */
async function measure(scenario: Scenario): Promise<number[]> {
  const reads: number[] = [];
  for (const n of SIZES) {
    const name = `plan-shape-gate-${++dbCounter}`;
    const db = await openSeededDb(name, seedRows(n));
    const driver = createIDBRuntimeDriver(name).create();
    const orm = idbOrm({ contract, executor: new TestExecutor(driver) }) as LooseOrm;
    let snap: ProbeSnapshot;
    try {
      probe.reset();
      await scenario.run(orm, n);
      snap = probe.snapshot();
    } finally {
      db.close();
      await driver.close();
    }
    reads.push(snap.valuesRead + snap.keysRead);
  }
  return reads;
}

let probe: IdbProbe;

beforeAll(() => {
  probe = installIdbProbe();
});

afterAll(() => {
  probe.uninstall();
});

describe("plan-shape gate", () => {
  it("assigns a budget to every scenario and has no stale budget keys", () => {
    expect(SCENARIOS.map(({ name }) => name).sort()).toEqual(Object.keys(READ_BUDGETS).sort());
    for (const budget of Object.values(READ_BUDGETS)) expect(budget).toHaveLength(SIZES.length);
  });
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} stays within the read budget at 100 and 1,000 rows`, async () => {
      const actual = await measure(scenario);
      const budget = READ_BUDGETS[scenario.name];
      expect(budget, `missing read budget for ${scenario.name}`).toBeDefined();
      for (const [index, reads] of actual.entries()) {
        // An unfiltered control proves the probe can observe a full scan.
        if (scenario.name === "findMany: no filter") expect(reads).toBeGreaterThanOrEqual(SIZES[index]!);
        expect(reads, `reads at store size ${SIZES[index]}`).toBeLessThanOrEqual(budget![index]!);
      }
    });
  }
});
