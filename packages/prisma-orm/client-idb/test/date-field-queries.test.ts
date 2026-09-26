/**
 * Filters and sorting on a `DateTime` field that isn't indexed.
 *
 * These run in memory, and `Date` values read back from IndexedDB are fresh
 * objects, so plain `===` never matches two equal dates. They must compare
 * the way an IndexedDB key range would, or the result depends on whether the
 * field happens to be indexed.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

let dbCounter = 0;
const nextDbName = () => `date-field-queries-test-${++dbCounter}`;

const JAN = "2026-01-01T00:00:00Z";
const FEB = "2026-02-01T00:00:00Z";

// `happensAt` is a plain, non-indexed DateTime field, so every filter and sort
// on it runs in memory rather than through an IndexedDB key range.
const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Event: { store: "events", key: "id", fields: { id: "String", label: "String", happensAt: "DateTime?" } },
  },
});

type Rows = Promise<Array<{ id: string }>>;
type LooseAccessor = {
  create(d: unknown): Promise<unknown>;
  where(w: unknown): { all(): { toArray(): Rows } };
  orderBy(spec: unknown): { all(): { toArray(): Rows } };
};

let db: IDBDatabase;

async function setup(): Promise<LooseAccessor> {
  const name = nextDbName();
  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("events", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  const orm = idbOrm({ contract, executor }) as unknown as Record<string, LooseAccessor>;
  const events = orm["events"]!;
  await events.create({ id: "e1", label: "b", happensAt: new Date(JAN) });
  await events.create({ id: "e2", label: "a", happensAt: new Date(JAN) });
  await events.create({ id: "e3", label: "c", happensAt: new Date(FEB) });
  await events.create({ id: "e4", label: "d", happensAt: null });
  return events;
}

const ids = async (rows: Rows) => (await rows).map((r) => r.id);

afterEach(() => db.close());

describe("filters on a non-indexed DateTime field", () => {
  it("shorthand equality matches an equal but distinct Date", async () => {
    const events = await setup();
    expect(
      (
        await ids(
          events
            .where({ happensAt: new Date(JAN) })
            .all()
            .toArray()
        )
      ).sort()
    ).toEqual(["e1", "e2"]);
  });

  it("eq / neq / in compare by value", async () => {
    const events = await setup();
    type M = { happensAt: { eq(v: Date): unknown; neq(v: Date): unknown; in(v: Date[]): unknown } };
    const q = (fn: (m: M) => unknown) => ids(events.where(fn).all().toArray());
    expect((await q((m) => m.happensAt.eq(new Date(JAN)))).sort()).toEqual(["e1", "e2"]);
    expect(await q((m) => m.happensAt.neq(new Date(JAN)))).not.toContain("e1");
    expect((await q((m) => m.happensAt.in([new Date(FEB)]))).sort()).toEqual(["e3"]);
  });
});

describe("orderBy on a DateTime field", () => {
  it("treats equal Dates as a tie, so the next field decides, and sorts null last", async () => {
    const events = await setup();
    const rows = await ids(events.orderBy({ happensAt: "asc", label: "asc" }).all().toArray());
    expect(rows).toEqual(["e2", "e1", "e3", "e4"]);
  });

  it("sorts null first when descending", async () => {
    const events = await setup();
    const rows = await ids(events.orderBy({ happensAt: "desc", label: "asc" }).all().toArray());
    expect(rows).toEqual(["e4", "e3", "e2", "e1"]);
  });
});
