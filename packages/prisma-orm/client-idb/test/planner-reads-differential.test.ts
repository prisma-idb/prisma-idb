import { expect, it } from "vitest";
import fc from "fast-check";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import {
  andExpr,
  evaluateFilter,
  fieldFilter as f,
  notExpr,
  orExpr,
  type IdbFilterExpr,
  type IdbQueryPlan,
} from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { compareFieldValues } from "@prisma-idb/target-idb/runtime";
import { idbOrm, type IdbQueryExecutor, type IdbStoreAccessor, type IdbContract } from "../src/exports/orm";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: {
        id: "String",
        serial: "Int",
        category: "String",
        rank: "Int",
        label: "String",
        flag: "Boolean",
        big: "BigInt",
        json: "Json",
        optional: "String?",
        float: "Float",
        date: "DateTime",
        bytes: "Bytes",
        decimal: "Decimal",
        tags: "Json",
      },
      indexes: {
        bySerial: { keyPath: "serial", unique: true },
        byCategory: { keyPath: "category" },
        byRank: { keyPath: "rank" },
        byLabel: { keyPath: "label" },
        byCategoryRankLabel: { keyPath: ["category", "rank", "label"] },
        byOptionalRank: { keyPath: ["optional", "rank"] },
        byCategoryOptional: { keyPath: ["category", "optional"] },
        byFloat: { keyPath: "float" },
        byDate: { keyPath: "date" },
        byBytes: { keyPath: "bytes" },
        byDecimal: { keyPath: "decimal" },
        byTags: { keyPath: "tags", multiEntry: true },
      },
    },
  },
});

const compoundContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: { id: "String", category: "String", rank: "Int", label: "String" },
      indexes: { byCategoryRankLabel: { keyPath: ["category", "rank", "label"] } },
    },
  },
});

class TestExecutor implements IdbQueryExecutor {
  constructor(readonly driver: IdbRuntimeDriverInstance) {}
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const iterable = this.driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of iterable) yield row as Row;
      })()
    );
  }
}

type Row = Record<string, unknown>;
type Order = Record<string, "asc" | "desc">;
type Query = { where?: IdbFilterExpr; orderBy?: Order; skip?: number; take?: number };
let dbCounter = 0;

async function withDatabase(
  run: (db: IDBDatabase, driver: IdbRuntimeDriverInstance) => Promise<void>,
  testContract: IdbContract = contract
) {
  const name = `planner-reads-differential-${++dbCounter}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const definition = testContract.storage.stores["items"]!;
      const store = request.result.createObjectStore("items", { keyPath: "id" });
      for (const [name, index] of Object.entries(definition.indexes ?? {}))
        store.createIndex(name, index.keyPath as string | string[], {
          unique: index.unique,
          multiEntry: index.multiEntry ?? false,
        });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const driver = createIDBRuntimeDriver(name).create();
  try {
    await run(db, driver);
  } finally {
    db.close();
    await driver.close();
    indexedDB.deleteDatabase(name);
  }
}

function seed(db: IDBDatabase, rows: Row[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    store.clear();
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Full store read, independent of planner and lowering, followed by the original filter. */
async function oracle(db: IDBDatabase, query: Query): Promise<Row[]> {
  const rows = await new Promise<Row[]>((resolve, reject) => {
    const request = db.transaction("items").objectStore("items").getAll();
    request.onsuccess = () => resolve(request.result as Row[]);
    request.onerror = () => reject(request.error);
  });
  const filtered = rows.filter((row) => query.where === undefined || evaluateFilter(query.where, row));
  if (query.orderBy)
    filtered.sort((a, b) => {
      for (const [field, direction] of Object.entries(query.orderBy!)) {
        const comparison = compareFieldValues(a[field], b[field]);
        if (comparison !== 0) return direction === "desc" ? -comparison : comparison;
      }
      return 0;
    });
  const skip = query.skip ?? 0;
  return filtered.slice(skip, query.take === undefined ? undefined : skip + query.take);
}

function accessor(
  driver: IdbRuntimeDriverInstance,
  testContract: IdbContract = contract
): IdbStoreAccessor<never, never> {
  const orm = idbOrm({ contract: testContract, executor: new TestExecutor(driver) });
  return (orm as unknown as Record<string, IdbStoreAccessor<never, never>>)["items"]!;
}

function applyQuery(base: IdbStoreAccessor<never, never>, query: Query) {
  let result = base;
  if (query.where) result = result.where(() => query.where!);
  if (query.orderBy) result = result.orderBy(query.orderBy);
  if (query.skip !== undefined) result = result.skip(query.skip);
  if (query.take !== undefined) result = result.take(query.take);
  return result;
}

async function compare(
  db: IDBDatabase,
  driver: IdbRuntimeDriverInstance,
  query: Query,
  testContract: IdbContract = contract
) {
  const actual = (await applyQuery(accessor(driver, testContract), query).all().toArray()) as Row[];
  const expected = await oracle(db, query);
  // Unordered queries below are unpaginated, so compare complete multisets.
  if (!query.orderBy) {
    const byId = (a: Row, b: Row) => compareFieldValues(a["id"], b["id"]);
    actual.sort(byId);
    expected.sort(byId);
  }
  expect(actual, "planned read matches full scan").toEqual(expected);
}

/** Check pagination without assuming primary-key order for unordered rows or ties. */
async function compareWithTies(db: IDBDatabase, driver: IdbRuntimeDriverInstance, query: Query) {
  const actual = (await applyQuery(accessor(driver), query).all().toArray()) as Row[];
  const matching = await oracle(db, query.where === undefined ? {} : { where: query.where });
  const expected = await oracle(db, query);
  expect(actual).toHaveLength(expected.length);
  expect(new Set(actual.map((row) => row["id"])).size).toBe(actual.length);
  for (const row of actual) expect(matching).toContainEqual(row);
  if (query.orderBy) {
    // A different tie selection is valid, but the page's ordered values must
    // match the full scan. This catches reversed order and incorrect offsets.
    const fields = Object.keys(query.orderBy);
    const values = (rows: Row[]) => rows.map((row) => fields.map((field) => row[field]));
    expect(values(actual)).toEqual(values(expected));
  } else if (query.skip === undefined && query.take === undefined) {
    const byId = (a: Row, b: Row) => compareFieldValues(a["id"], b["id"]);
    expect(actual.sort(byId)).toEqual(matching.sort(byId));
  }
}

const number = fc.integer({ min: -10, max: 10 });
const text = fc.constantFrom("", "a", "ab", "b", "\uffff", "a\uffff");
const data = fc
  .array(
    fc.record({
      category: text,
      rank: number,
      label: text,
      flag: fc.boolean(),
      optional: fc.option(text, { nil: null }),
      float: fc.oneof(number, fc.constant(NaN)),
      date: fc.oneof(
        number.map((n) => new Date(n)),
        fc.constant(new Date(NaN))
      ),
    }),
    { minLength: 1, maxLength: 40 }
  )
  .map((rows) =>
    rows.map((row, i) => ({
      ...row,
      id: `i${String(i).padStart(3, "0")}`,
      serial: rows.length - i,
      big: BigInt(row.rank),
      json: { n: row.rank },
      bytes: new Uint8Array([row.rank + 10]),
      decimal: String(row.rank),
      tags: [row.category, row.label],
    }))
  );

it("matches full scan for each accelerated shape and conservative fallback", async () => {
  await withDatabase(async (db, driver) => {
    await fc.assert(
      fc.asyncProperty(data, text, number, text, async (rows, category, rank, label) => {
        await seed(db, rows);
        const filters = [
          f("id", "eq", rows[0]!.id),
          f("id", "in", [rows[0]!.id, rows.at(-1)!.id, rows[0]!.id]),
          f("serial", "eq", 1),
          f("category", "eq", category),
          f("category", "in", [category, label, category]),
          orExpr([f("category", "eq", category), f("category", "in", [label, category])]),
          andExpr([f("category", "eq", category), f("flag", "eq", true)]),
          f("rank", "gt", rank),
          f("rank", "gte", rank),
          f("rank", "lt", rank),
          f("rank", "lte", rank),
          andExpr([f("rank", "gte", rank), f("rank", "lt", rank + 3)]),
          f("label", "startsWith", label),
          andExpr([f("category", "eq", category), f("rank", "eq", rank), f("label", "eq", label)]),
          andExpr([f("category", "in", [category, label]), f("rank", "in", [rank, rank + 1])]),
          andExpr([f("category", "eq", category), f("rank", "gt", rank), f("rank", "lte", rank + 3)]),
          andExpr([f("category", "eq", category), f("rank", "eq", rank), f("label", "startsWith", label)]),
          f("optional", "eq", null),
          andExpr([f("optional", "eq", category), f("rank", "lt", rank)]),
          orExpr([f("category", "eq", category), f("rank", "eq", rank)]),
          notExpr(f("category", "eq", category)),
          f("label", "contains", label),
          f("flag", "eq", true),
          f("big", "gte", BigInt(rank)),
          f("json", "eq", { n: rank }),
          f("tags", "eq", [category, label]),
          f("float", "gte", rank),
          f("date", "lte", new Date(rank)),
          f("float", "gt", rank),
          f("date", "lt", new Date(rank)),
          f("float", "eq", rank),
          f("date", "eq", new Date(rank)),
          f("decimal", "eq", String(rank)),
          f("decimal", "gt", String(rank)),
          f("bytes", "gt", new Uint8Array([rank + 10])),
          f("bytes", "eq", new Uint8Array([rank + 10])),
          f("decimal", "startsWith", "1"),
          f("category", "in", []),
          andExpr([f("rank", "gt", rank), f("rank", "lt", rank)]),
        ];
        for (const where of filters) {
          await compare(db, driver, { where });
          // A total order also checks global sorting/pagination across multiple ranges.
          await compare(db, driver, { where, orderBy: { serial: "desc" }, skip: 1, take: 4 });
        }
        for (const orderBy of [
          { serial: "asc" },
          { serial: "desc" },
          { id: "desc" },
          { category: "asc", id: "desc" },
        ] as Order[])
          await compare(db, driver, { orderBy, skip: 2, take: 5 });
        await compare(db, driver, {
          where: f("serial", "in", [1, 3, 2, 3]),
          orderBy: { serial: "desc" },
          skip: 1,
          take: 1,
        });
        await compare(db, driver, { orderBy: { serial: "asc" }, take: 0 });
        for (const where of [
          andExpr([f("serial", "gte", 1), f("flag", "eq", true)]),
          andExpr([f("serial", "in", [1, 2, 3, 4]), f("flag", "eq", true)]),
        ]) {
          await compare(db, driver, { where, orderBy: { serial: "asc" }, skip: 1, take: 2 });
          await compare(db, driver, { where, orderBy: { serial: "desc" }, take: 1 });
        }
        const first = await accessor(driver)
          .where(() => f("serial", "eq", 1))
          .first();
        expect(first).toEqual((await oracle(db, { where: f("serial", "eq", 1) }))[0] ?? null);
        const unique = await accessor(driver).findUnique(rows[0]!.id as never);
        expect(unique).toEqual((await oracle(db, { where: f("id", "eq", rows[0]!.id) }))[0]);
      }),
      { seed: 99004, numRuns: 40 }
    );
  });
});

it("matches full scan for generated boolean combinations of filters", async () => {
  const atom = fc.oneof(
    fc
      .tuple(text, fc.constantFrom("eq", "startsWith", "contains" as const))
      .map(([value, op]) => f("category", op, value)),
    fc
      .tuple(number, fc.constantFrom("eq", "gt", "gte", "lt", "lte" as const))
      .map(([value, op]) => f("rank", op, value)),
    fc.array(text, { maxLength: 5 }).map((values) => f("category", "in", values))
  );
  const filter = fc.oneof(
    atom,
    fc.array(atom, { maxLength: 4 }).map(andExpr),
    fc.array(atom, { maxLength: 4 }).map(orExpr),
    atom.map(notExpr)
  );
  await withDatabase(async (db, driver) => {
    await fc.assert(
      fc.asyncProperty(data, filter, fc.boolean(), async (rows, where, descending) => {
        await seed(db, rows);
        await compare(db, driver, { where });
        await compare(db, driver, { where, orderBy: { serial: descending ? "desc" : "asc" }, skip: 1, take: 3 });
      }),
      { seed: 99005, numRuns: 150 }
    );
  });
});

it("keeps matching rows and ordered values when pagination crosses ties", async () => {
  const tiedData = fc
    .array(
      fc.record({
        category: fc.constantFrom("a", "b"),
        rank: fc.integer({ min: 1, max: 2 }),
        label: fc.constantFrom("x", "y"),
        flag: fc.boolean(),
      }),
      { minLength: 6, maxLength: 30 }
    )
    .map((rows) => rows.map((row, i) => ({ ...row, id: `i${String(i).padStart(3, "0")}`, serial: i })));
  await withDatabase(async (db, driver) => {
    const check = async (rows: Row[], skip: number, take: number) => {
      await seed(db, rows);
      const queries: Query[] = [
        {},
        { where: f("rank", "gte", 1) },
        { where: f("rank", "in", [2, 1, 2]) },
        { where: f("category", "in", ["b", "a", "b"]) },
        { where: andExpr([f("category", "in", ["b", "a"]), f("flag", "eq", true)]) },
      ];
      for (const query of queries) {
        const matching = await oracle(db, query);
        await compareWithTies(db, driver, query);
        await compareWithTies(db, driver, { ...query, skip, take });
        for (const direction of ["asc", "desc"] as const) {
          await compareWithTies(db, driver, { ...query, orderBy: { rank: direction }, skip, take });
          await compareWithTies(db, driver, { ...query, orderBy: { rank: direction } });
          // Adding the unique id makes tie selection and pagination exact.
          await compare(db, driver, { ...query, orderBy: { rank: direction, id: "asc" }, skip, take });
          const first = await applyQuery(accessor(driver), { ...query, orderBy: { rank: direction } }).first();
          const expected = await oracle(db, { ...query, orderBy: { rank: direction }, take: 1 });
          if (expected.length === 0) expect(first).toBeNull();
          else {
            expect(matching).toContainEqual(first);
            expect((first as Row)["rank"]).toBe(expected[0]!["rank"]);
          }
        }
        const first = await applyQuery(accessor(driver), query).first();
        if (matching.length === 0) expect(first).toBeNull();
        else expect(matching).toContainEqual(first);
      }
    };
    // Pin the reviewer's boundary cases before exploring generated tied data.
    await check(
      [
        { id: "i1", serial: 1, category: "a", rank: 1, flag: true },
        { id: "i2", serial: 2, category: "b", rank: 1, flag: false },
        { id: "i3", serial: 3, category: "a", rank: 2, flag: true },
        { id: "i4", serial: 4, category: "b", rank: 2, flag: false },
        { id: "i5", serial: 5, category: "a", rank: 1, flag: false },
        { id: "i6", serial: 6, category: "b", rank: 1, flag: true },
      ],
      0,
      3
    );
    await fc.assert(
      fc.asyncProperty(tiedData, fc.integer({ min: 0, max: 35 }), fc.integer({ min: 0, max: 8 }), check),
      { seed: 99007, numRuns: 50 }
    );
  });
});

it("returns null from findUnique when the key is not a valid IndexedDB key", async () => {
  await withDatabase(async (db, driver) => {
    await seed(db, [{ id: "a", serial: 1, category: "a", rank: 1 }]);
    expect(await accessor(driver).findUnique(NaN as never)).toBeNull();
  });
});

it("matches full scan for compound prefixes, Cartesian points, and trailing bounds", async () => {
  await withDatabase(async (db, driver) => {
    await fc.assert(
      fc.asyncProperty(data, text, text, number, async (rows, category, label, rank) => {
        await seed(db, rows);
        const prefix = f("category", "in", [category, label, category]);
        const filters = [
          prefix,
          f("category", "startsWith", category),
          f("category", "gt", category),
          andExpr([prefix, f("rank", "in", [rank, rank + 1, rank])]),
          andExpr([prefix, f("rank", "eq", rank), f("label", "eq", label)]),
          ...["gt", "gte", "lt", "lte"].map((op) =>
            andExpr([prefix, f("rank", op as "gt" | "gte" | "lt" | "lte", rank)])
          ),
          andExpr([prefix, f("rank", "gte", rank), f("rank", "lte", rank + 2)]),
          andExpr([prefix, f("rank", "eq", rank), f("label", "startsWith", label)]),
        ];
        for (const where of filters) {
          await compare(db, driver, { where }, compoundContract);
          await compare(
            db,
            driver,
            { where, orderBy: { rank: "desc", id: "asc" }, skip: 1, take: 3 },
            compoundContract
          );
        }
      }),
      { seed: 99006, numRuns: 60 }
    );
  }, compoundContract);
});

it("aggregate and groupBy reapply residual filters and ignore collection pagination", async () => {
  await withDatabase(async (db, driver) => {
    const rows = [
      { id: "a", serial: 3, category: "a", rank: 2, flag: true },
      { id: "b", serial: 2, category: "a", rank: 8, flag: false },
      { id: "c", serial: 1, category: "b", rank: 5, flag: true },
    ];
    await seed(db, rows);
    const where = andExpr([f("category", "in", ["a", "b", "a"]), f("flag", "eq", true)]);
    const expected = await oracle(db, { where });
    const query = accessor(driver)
      .where(() => where)
      .skip(100)
      .take(0);
    const aggregate = await query.aggregate((a) => ({ count: a.count(), sum: a.sum("rank" as never) }));
    expect(aggregate).toEqual({ count: expected.length, sum: 7 });
    const groups = await query
      .groupBy("category" as never)
      .aggregate((a) => ({ count: a.count(), sum: a.sum("rank" as never) }));
    expect(groups).toEqual([
      { category: "a", count: 1, sum: 2 },
      { category: "b", count: 1, sum: 5 },
    ]);
  });
});
