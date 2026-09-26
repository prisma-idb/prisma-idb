/**
 * Relations joined on a `DateTime` key.
 *
 * `Date` values read back from IndexedDB are fresh objects, so JS `===` never
 * matches two equal dates. Since Phase 9.4 an FK to a `DateTime`-keyed parent
 * passes validation (key equality), so every path that later joins on that FK
 * — referential actions and `include()` — must compare the same way, or the
 * child is silently orphaned / never loaded.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type { IdbReferentialAction } from "@prisma-idb/target-idb/pack";
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
const nextDbName = () => `date-key-relations-test-${++dbCounter}`;

const JAN = "2026-01-01T00:00:00Z";

function periodContract(onDelete?: IdbReferentialAction) {
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Period: {
        store: "periods",
        key: "startsAt",
        fields: { startsAt: "DateTime", label: "String" },
        relations: {
          entries: {
            to: "Entry",
            cardinality: "1:N",
            on: { local: ["startsAt"], target: ["periodStart"] },
            ...(onDelete !== undefined ? { onDelete } : {}),
          },
        },
      },
      Entry: {
        store: "entries",
        key: "id",
        fields: { id: "String", periodStart: "DateTime?" },
        relations: {
          period: { to: "Period", cardinality: "N:1", on: { local: ["periodStart"], target: ["startsAt"] } },
        },
      },
    },
  });
}

function openTestDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("periods", { keyPath: "startsAt" });
      req.result.createObjectStore("entries", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllRows(db: IDBDatabase, storeName: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction([storeName], "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
    req.onerror = () => reject(req.error);
  });
}

type LooseAccessor = {
  create(d: unknown): Promise<unknown>;
  delete(k: unknown): Promise<unknown>;
  include(rel: string, refine?: (r: { count(): unknown }) => unknown): { all(): { toArray(): Promise<unknown[]> } };
};

let db: IDBDatabase;

/** Fresh DB with one January period and one entry pointing at it by an equal-but-distinct Date. */
async function setup(onDelete?: IdbReferentialAction) {
  const name = nextDbName();
  db = await openTestDb(name);
  const executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  const orm = idbOrm({ contract: periodContract(onDelete), executor }) as unknown as Record<string, LooseAccessor>;
  await orm["periods"]!.create({ startsAt: new Date(JAN), label: "Jan" });
  await orm["entries"]!.create({ id: "e1", periodStart: new Date(JAN) });
  return orm;
}

afterEach(() => db.close());

describe("onDelete on a DateTime-keyed parent", () => {
  it("cascade deletes the child", async () => {
    const orm = await setup("cascade");
    await orm["periods"]!.delete(new Date(JAN));
    expect(await getAllRows(db, "periods")).toHaveLength(0);
    expect(await getAllRows(db, "entries")).toHaveLength(0);
  });

  it("restrict blocks the delete", async () => {
    const orm = await setup("restrict");
    await expect(orm["periods"]!.delete(new Date(JAN))).rejects.toThrow(/Cannot delete Period.*child records/);
    expect(await getAllRows(db, "periods")).toHaveLength(1);
    expect(await getAllRows(db, "entries")).toHaveLength(1);
  });

  it("setNull nulls the child's FK", async () => {
    const orm = await setup("setNull");
    await orm["periods"]!.delete(new Date(JAN));
    expect(await getAllRows(db, "entries")).toEqual([{ id: "e1", periodStart: null }]);
  });
});

describe("include() joined on a DateTime key", () => {
  let orm: Record<string, LooseAccessor>;
  beforeEach(async () => {
    orm = await setup();
    await orm["entries"]!.create({ id: "e2", periodStart: new Date(JAN) });
  });

  it("loads 1:N children", async () => {
    const [period] = (await orm["periods"]!.include("entries").all().toArray()) as Array<{
      entries: Array<{ id: string }>;
    }>;
    expect(period!.entries.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("counts 1:N children", async () => {
    const [period] = (await orm["periods"]!.include("entries", (r) => r.count())
      .all()
      .toArray()) as Array<{
      entries: number;
    }>;
    expect(period!.entries).toBe(2);
  });

  it("loads the N:1 parent", async () => {
    const entries = (await orm["entries"]!.include("period").all().toArray()) as Array<{
      period: { label: string } | null;
    }>;
    expect(entries.map((e) => e.period?.label)).toEqual(["Jan", "Jan"]);
  });
});
