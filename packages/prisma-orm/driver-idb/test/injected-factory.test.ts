/**
 * A driver given its own IndexedDB implementation must not reach for the
 * global one, which a realm such as a worker or a server test may not have.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIDBRuntimeDriver } from "../src/exports/runtime";

const META = { target: "idb", storageHash: "test", lane: "test" } as const;

describe("a driver with an injected factory and no global IndexedDB", () => {
  const factory = new IDBFactory();

  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("injected", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("users", { keyPath: "id" }).createIndex("byScore", "score");
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("IDBKeyRange", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates inline-key rows and scans ranges with the injected implementation", async () => {
    const driver = createIDBRuntimeDriver("injected", undefined, { factory, keyRange: IDBKeyRange }).create();
    try {
      const run = async (plan: object) => {
        const rows: unknown[] = [];
        for await (const row of driver.execute(plan as never)) rows.push(row);
        return rows;
      };
      await run({ meta: META, kind: "put", storeName: "users", record: { id: "u1", score: 1 } });
      await run({ meta: META, kind: "put", storeName: "users", record: { id: "u2", score: 5 } });

      expect(await run({ meta: META, kind: "update", storeName: "users", key: "u1", patch: { score: 2 } })).toEqual([
        { id: "u1", score: 2 },
      ]);
      const scanned = await run({
        meta: META,
        kind: "cursor-scan",
        storeName: "users",
        indexName: "byScore",
        range: { kind: "lower", key: 3, open: false },
      });
      expect(scanned).toEqual([{ id: "u2", score: 5 }]);
    } finally {
      await driver.close();
    }
  });
});
