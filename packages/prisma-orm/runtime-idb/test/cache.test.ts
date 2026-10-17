import { emptyCodecLookup } from "@prisma/orm-framework/components/codec";
import type { ActivityContext } from "@prisma/orm-framework/components/runtime";
import {
  evaluateFilter,
  fieldFilter,
  IdbAdapter,
  type IdbFindManyAst,
  type IdbQueryPlan,
} from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver, type IdbCursorScanPlan, type IdbPlanBody } from "@prisma-idb/driver-idb/runtime";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdbMiddleware } from "../src/idb-middleware";
import { createIdbRuntime, type IdbRuntime } from "../src/idb-runtime";

const META = { target: "idb", storageHash: "test-hash", lane: "idb" } as const;
const ROWS = [
  { id: 1, score: 30 },
  { id: 2, score: 10 },
  { id: 3, score: 20 },
];
const runtimes: IdbRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

/** The cache key and rows of the read an activity is running. */
interface PendingRead {
  readonly key: string;
  readonly rows: Record<string, unknown>[];
}

/** Cache complete query results by the runtime's content hash, including real interception on hits. */
function readCache(): IdbMiddleware {
  const entries = new Map<string, Record<string, unknown>[]>();
  const pendingRead = Symbol("read-cache.pending");
  const pendingOf = (ctx: ActivityContext) => ctx.state(pendingRead)["read"] as PendingRead;
  return {
    name: "read-cache",
    familyId: "idb",
    async beforeEncode(plan, ctx) {
      ctx.state(pendingRead)["read"] = { key: await ctx.contentHash(plan), rows: [] };
    },
    intercept: {
      async onQuery(_plan, ctx) {
        const rows = entries.get(pendingOf(ctx).key);
        return rows === undefined ? undefined : { rows };
      },
    },
    async onRow(row, _plan, ctx) {
      pendingOf(ctx).rows.push(row);
    },
    async activityEnded(_activity, result, ctx) {
      if (result.kind !== "statement") return;
      const entry = pendingOf(ctx);
      if (result.outcome === "succeeded") entries.set(entry.key, entry.rows);
    },
  };
}

/** Seed a fresh IndexedDB and wire the actual adapter, driver and caching middleware. */
async function setup() {
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = factory.open("cache-test", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("users", { keyPath: "id" });
      for (const row of ROWS) store.add(row);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const driver = createIDBRuntimeDriver("cache-test", 1, { factory }).create();
  const execute = vi.spyOn(driver, "execute");
  const runtime = createIdbRuntime({
    adapter: new IdbAdapter(emptyCodecLookup),
    driver,
    contract: { storage: { storageHash: META.storageHash } },
    middleware: [readCache()],
  });
  runtimes.push(runtime);
  return { runtime, execute };
}

/** Pair a driver plan with optional structured intent, as the ORM lane does. */
function queryPlan(body: Partial<IdbCursorScanPlan> = {}, ast?: IdbFindManyAst): IdbQueryPlan {
  const idbPlan: IdbPlanBody = { meta: META, kind: "cursor-scan", storeName: "users", ...body };
  return { meta: META, idbPlan, ...(ast === undefined ? {} : { ast }) };
}

/** Build fresh closures from values captured by otherwise-identical structured reads. */
function filteredPlan(score: number): IdbQueryPlan {
  const where = fieldFilter("score", "eq", score);
  return queryPlan({ filter: (row) => evaluateFilter(where, row) }, { kind: "findMany", modelName: "User", where });
}

/** Preserve field priority when building the comparator, matching the client. */
function sortedPlan(orderBy: Record<string, "asc" | "desc">): IdbQueryPlan {
  return queryPlan(
    {
      comparator: (a, b) => {
        for (const [field, direction] of Object.entries(orderBy)) {
          const difference = Number(a[field]) - Number(b[field]);
          if (difference !== 0) return direction === "asc" ? difference : -difference;
        }
        return 0;
      },
    },
    { kind: "findMany", modelName: "User", orderBy }
  );
}

/** Model a range-split read whose child scans share the query's predicate. */
function batchedPlan(score: number, structured: boolean): IdbQueryPlan {
  const plan = filteredPlan(score);
  const scan = plan.idbPlan as IdbCursorScanPlan;
  return {
    meta: META,
    ...(structured ? { ast: plan.ast! } : {}),
    idbPlan: {
      meta: META,
      kind: "batch",
      storeNames: ["users"],
      ops: [
        { ...scan, range: { kind: "upper", key: 2 } },
        { ...scan, range: { kind: "lower", key: 3 } },
      ],
    },
  };
}

describe("middleware read cache", () => {
  it("separates captured filter values and reuses equivalent structured plans", async () => {
    const { runtime, execute } = await setup();
    expect(await runtime.query(filteredPlan(10))).toEqual([ROWS[1]]);
    expect(await runtime.query(filteredPlan(20))).toEqual([ROWS[2]]);
    const equivalent = queryPlan(
      { filter: (row) => row["score"] === 10 },
      {
        where: { value: 10, op: "eq", field: "score", kind: "field" },
        modelName: "User",
        kind: "findMany",
      }
    );
    expect(await runtime.query(equivalent)).toEqual([ROWS[1]]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("separates sort directions and field priority while reusing identical sorts", async () => {
    const { runtime, execute } = await setup();
    expect(await runtime.query(sortedPlan({ score: "asc", id: "asc" }))).toEqual([ROWS[1], ROWS[2], ROWS[0]]);
    expect(await runtime.query(sortedPlan({ score: "desc", id: "asc" }))).toEqual([ROWS[0], ROWS[2], ROWS[1]]);
    expect(await runtime.query(sortedPlan({ id: "asc", score: "asc" }))).toEqual(ROWS);
    expect(await runtime.query(sortedPlan({ score: "asc", id: "asc" }))).toEqual([ROWS[1], ROWS[2], ROWS[0]]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("never reuses raw filters with mutable captures (incomplete AST: %s)", async (withAst) => {
    const { runtime, execute } = await setup();
    let score = 10;
    const plan = queryPlan(
      { filter: (row) => row["score"] === score },
      withAst ? { kind: "findMany", modelName: "User" } : undefined
    );
    expect(await runtime.query(plan)).toEqual([ROWS[1]]);
    score = 20;
    expect(await runtime.query(plan)).toEqual([ROWS[2]]);
    expect(await runtime.query(queryPlan())).toEqual(ROWS);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("never reuses raw comparators with mutable captured state", async () => {
    const { runtime, execute } = await setup();
    let direction = 1;
    const plan = queryPlan({ comparator: (a, b) => direction * (Number(a["score"]) - Number(b["score"])) });
    expect(await runtime.query(plan)).toEqual([ROWS[1], ROWS[2], ROWS[0]]);
    direction = -1;
    expect(await runtime.query(plan)).toEqual([ROWS[0], ROWS[2], ROWS[1]]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("handles closures in range-split batches (structured: %s)", async (structured) => {
    const { runtime, execute } = await setup();
    expect(await runtime.query(batchedPlan(10, structured))).toEqual([ROWS[1]]);
    expect(await runtime.query(batchedPlan(20, structured))).toEqual([ROWS[2]]);
    expect(await runtime.query(batchedPlan(10, structured))).toEqual([ROWS[1]]);
    expect(execute).toHaveBeenCalledTimes(structured ? 2 : 3);
  });

  it("separates key-range bounds and openness and reuses equal ranges", async () => {
    const { runtime, execute } = await setup();
    const plan = (upper: number, upperOpen = false) =>
      queryPlan({ range: { kind: "bound", lower: 1, upper, upperOpen } });
    expect(await runtime.query(plan(2))).toEqual([ROWS[0], ROWS[1]]);
    expect(await runtime.query(plan(3))).toEqual(ROWS);
    expect(await runtime.query(plan(3, true))).toEqual([ROWS[0], ROWS[1]]);
    expect(await runtime.query(plan(2))).toEqual([ROWS[0], ROWS[1]]);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
