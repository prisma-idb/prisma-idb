import { emptyCodecLookup } from "@prisma/orm-framework/components/codec";
import { IdbAdapter, type IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import { createIdbRuntime } from "@prisma-idb/runtime-idb/runtime";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { lowerRows, type RowsRequest } from "../../src/core/planner/lower";
import { planQuery } from "../../src/core/planner/plan";
import { catalog } from "./fixtures";

const META = { target: "idb", storageHash: "read-cache-test", lane: "idb" } as const;

it.each<RowsRequest>([{}, { orderBy: { n: "asc" } }])(
  "reuses fresh unfiltered lowered plans for %j",
  async (request) => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open("read-cache-test", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("items", { keyPath: "id" });
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const driver = createIDBRuntimeDriver("read-cache-test", 1, { factory }).create();
    const execute = vi.spyOn(driver, "execute");
    const hashes: string[] = [];
    const runtime = createIdbRuntime({
      adapter: new IdbAdapter(emptyCodecLookup),
      driver,
      contract: { storage: { storageHash: META.storageHash } },
      middleware: [
        {
          name: "read-cache",
          intercept: {
            async onQuery(plan, ctx) {
              const hash = await ctx.contentHash(plan);
              const hit = hashes.includes(hash);
              hashes.push(hash);
              return hit ? { rows: [] } : undefined;
            },
          },
        },
      ],
    });
    const queryCatalog = catalog();
    /** Lower each request independently, as separate ORM calls do. */
    function freshPlan(): IdbQueryPlan {
      const lowered = lowerRows(queryCatalog, planQuery(queryCatalog, request), META, request);
      return {
        meta: META,
        idbPlan: lowered.idbPlan,
        ast: { kind: "findMany", modelName: "Item", ...request },
      };
    }
    try {
      const first = freshPlan();
      const second = freshPlan();
      expect(first.idbPlan).not.toBe(second.idbPlan);
      expect(first.idbPlan).not.toHaveProperty("filter");
      expect(await runtime.query(first)).toEqual([]);
      expect(await runtime.query(second)).toEqual([]);
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).toBe(hashes[1]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  }
);

it("keeps additional filters when where is absent", () => {
  const queryCatalog = catalog();
  const lowered = lowerRows(queryCatalog, planQuery(queryCatalog, {}), META, {}, (row) => row["n"] === 2);
  expect(lowered.idbPlan).toHaveProperty("filter", expect.any(Function));
  expect(
    lowered.finish([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ])
  ).toEqual([{ id: "b", n: 2 }]);
});

it("normalizes absent fields even when the row filter is omitted", () => {
  const queryCatalog = {
    ...catalog(),
    absentAsNull: (row: Record<string, unknown>) => ({ optional: null, ...row }),
  };
  const lowered = lowerRows(queryCatalog, planQuery(queryCatalog, {}), META, {});
  expect(lowered.finish([{ id: "a" }])).toEqual([{ id: "a", optional: null }]);
});
