/**
 * Plan-shape gate: how much IndexedDB work each query shape does.
 *
 * For each query shape, the gate runs the query against a fresh database at
 * two sizes and records what IndexedDB was asked to do (see `_idb-probe.ts`):
 * how many record values were deserialized, how many keys were read, and
 * which stores/indexes were opened with or without a key range.
 *
 * The numbers are exact and deterministic. A shape that is served by an
 * index reads the same number of values at both sizes, or a number that
 * grows only with the match count. A full scan reads every record, so its
 * count grows with the store.
 *
 * `EXPECTED` pins today's behavior. A change to query planning must update
 * this table, and the diff of the table is the evidence of what changed.
 * Set `PLAN_GATE_RECORD=1` to print the measured table instead of asserting,
 * and pass `--silent=false` so vitest shows it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import { and, idbOrm, or } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";
import { installIdbProbe, summarizeRequests, type IdbProbe, type ProbeSnapshot } from "./_idb-probe";

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
    name: "upsert: indexed existing-row lookup",
    run: (o) => o["items"].upsert({ where: { category: "c3" }, create: { id: "new" }, update: { status: "archived" } }),
  },
  {
    name: "deleteAll: eq on indexed field",
    run: (o) => o["items"].where({ category: "c3" }).deleteAll().toArray(),
  },
];

interface Measurement {
  /** Values deserialized, at each size in {@link SIZES}. */
  readonly values: readonly number[];
  /** Primary keys read by key-only reads, at each size. */
  readonly keys: readonly number[];
  /** Requests issued at the largest size (see `summarizeRequests`). */
  readonly requests: readonly string[];
}

/**
 * Planned reads, counts, existence checks and mutation lookups.
 * `values`/`keys` list one entry per size in {@link SIZES}.
 */
const EXPECTED: Record<string, Measurement> = {
  "findMany: no filter": { values: [100, 1000], keys: [0, 0], requests: ["openCursor items"] },
  "findMany: eq on primary key": { values: [1, 1], keys: [0, 0], requests: ["get items range"] },
  "findUnique: primary key": { values: [1, 1], keys: [0, 0], requests: ["get items range"] },
  "findMany: eq on indexed field": { values: [10, 100], keys: [0, 0], requests: ["getAll items.byCategory range"] },
  "findMany: eq on non-indexed field": { values: [100, 1000], keys: [0, 0], requests: ["openCursor items"] },
  "findMany: indexed eq AND non-indexed eq": {
    values: [10, 100],
    keys: [0, 0],
    requests: ["getAll items.byCategory range"],
  },
  "findMany: lt on indexed field": { values: [20, 20], keys: [0, 0], requests: ["getAll items.byScore range"] },
  "findMany: gte AND lt on indexed field": { values: [20, 20], keys: [0, 0], requests: ["getAll items.byScore range"] },
  "findMany: in() on indexed field": {
    values: [20, 200],
    keys: [0, 0],
    requests: ["getAll items.byCategory range x2"],
  },
  "findMany: OR of indexed eqs": { values: [20, 200], keys: [0, 0], requests: ["getAll items.byCategory range x2"] },
  "findMany: OR with an AND branch": { values: [100, 1000], keys: [0, 0], requests: ["openCursor items"] },
  "findMany: OR mixing indexed and non-indexed": { values: [100, 1000], keys: [0, 0], requests: ["openCursor items"] },
  "findMany: compound index exact match": { values: [1, 1], keys: [0, 0], requests: ["getAll items.byOrgRank range"] },
  "findMany: compound index prefix": { values: [20, 200], keys: [0, 0], requests: ["getAll items.byOrgRank range"] },
  "findMany: orderBy indexed field, take 10": {
    values: [10, 10],
    keys: [0, 0],
    requests: ["openCursor items.byScore"],
  },
  "findMany: indexed in with orderBy and take 2": {
    values: [4, 4],
    keys: [0, 0],
    requests: ["openCursor items.byCategory range x2"],
  },
  "findFirst: eq on indexed field": { values: [1, 1], keys: [0, 0], requests: ["openCursor items.byCategory range"] },
  "count: no filter": { values: [0, 0], keys: [0, 0], requests: ["count items"] },
  "count: eq on indexed field": { values: [0, 0], keys: [0, 0], requests: ["count items.byCategory range"] },
  // The non-indexed field needs the rows, but only those in the index range.
  "count: indexed eq AND non-indexed eq": {
    values: [10, 100],
    keys: [0, 0],
    requests: ["getAll items.byCategory range"],
  },
  "count: in() on indexed field": { values: [0, 0], keys: [0, 0], requests: ["count items.byCategory range x2"] },
  "count: lt on indexed field": { values: [0, 0], keys: [0, 0], requests: ["count items.byScore range"] },
  "aggregate: count and sum, eq on indexed field": {
    values: [10, 100],
    keys: [0, 0],
    requests: ["getAll items.byCategory range"],
  },
  "include 1:N via indexed foreign key": {
    values: [11, 11],
    keys: [0, 0],
    requests: ["get authors range", "getAll books.byAuthor range"],
  },
  "include N:1 via primary key": { values: [2, 2], keys: [0, 0], requests: ["get authors range", "get books range"] },
  // Each parent lookup reads one primary key and no row.
  "create: foreign key validation": {
    values: [0, 0],
    keys: [2, 2],
    requests: ["getKey authors range", "getKey publishers range"],
  },
  "delete: cascade to children via indexed foreign key": {
    values: [22, 22],
    keys: [0, 0],
    requests: [
      "get authors range",
      "getAll books.byAuthor range",
      "openCursor authors range",
      "openCursor books range x10",
    ],
  },
  "delete: restrict check, no children": {
    values: [2, 2],
    keys: [0, 0],
    requests: ["get publishers range", "getKey books.byPublisher range", "openCursor publishers range"],
  },
  "updateAll: eq on indexed field": {
    values: [10, 100],
    keys: [0, 0],
    requests: ["openCursor items.byCategory range"],
  },
  "deleteAll: eq on indexed field": {
    values: [10, 100],
    keys: [0, 0],
    requests: ["openCursor items.byCategory range"],
  },
  "updateAll: range on indexed field": { values: [20, 20], keys: [0, 0], requests: ["openCursor items.byScore range"] },
  "updateAll: changes walked index field": {
    values: [20, 200],
    keys: [0, 0],
    requests: ["get items range x100", "getAll items.byCategory range"],
  },
  "update: eq on indexed field": { values: [1, 1], keys: [0, 0], requests: ["openCursor items.byCategory range"] },
  "upsert: indexed existing-row lookup": {
    values: [2, 2],
    keys: [0, 0],
    requests: ["get items range", "openCursor items.byCategory range"],
  },
};

// ── Gate ──────────────────────────────────────────────────────────────────────

// client-idb has no Node types; vitest runs in Node, so `process` exists at runtime.
const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
const RECORD = env["PLAN_GATE_RECORD"] === "1";

let dbCounter = 0;

async function measure(scenario: Scenario): Promise<Measurement> {
  const values: number[] = [];
  const keys: number[] = [];
  let requests: readonly string[] = [];
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
    values.push(snap.valuesRead);
    keys.push(snap.keysRead);
    requests = summarizeRequests(snap.requests);
  }
  return { values, keys, requests };
}

let probe: IdbProbe;
const recorded: Record<string, Measurement> = {};

beforeAll(() => {
  probe = installIdbProbe();
});

afterAll(() => {
  probe.uninstall();
  if (RECORD) console.log(JSON.stringify(recorded, null, 2));
});

describe("plan-shape gate", () => {
  it("covers every scenario in EXPECTED, and nothing else", () => {
    if (RECORD) return;
    expect(Object.keys(EXPECTED).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const actual = await measure(scenario);
      if (RECORD) {
        recorded[scenario.name] = actual;
        return;
      }
      expect(actual).toEqual(EXPECTED[scenario.name]);
    });
  }
});
