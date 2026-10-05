/**
 * Plan vocabulary tests: index name, key range and direction on `get-all`,
 * `cursor-scan` and `scan-write`, plus `toIdbKeyRange`.
 *
 * Every test reads a store whose primary-key order differs from its index
 * order, so a read that silently ignores `indexName` or `direction` fails.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeIdbPlan } from "../src/core/execute/index";
import { toIdbKeyRange } from "../src/core/execute/key-range";
import type {
  IdbAtomicPlan,
  IdbBatchPlan,
  IdbCursorScanPlan,
  IdbGetAllPlan,
  IdbKeyRangeDescriptor,
  IdbScanWritePlan,
} from "../src/core/plan-body";

const META = { target: "idb", storageHash: "test-hash", lane: "test" } as const;

let dbCounter = 0;

/**
 * Store `items`, keyed by `id`, with a non-unique index `by-n` on `n` and a compound index `by-group-n`.
 * Primary-key order is a..f; `by-n` order is f, e, c, d, b, a.
 */
function openItemsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`plan-vocabulary-${++dbCounter}`, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("items", { keyPath: "id" });
      store.createIndex("by-n", "n");
      store.createIndex("by-group-n", ["group", "n"]);
      for (const item of ITEMS) store.put(item);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type Item = { id: string; group: string; n: number };

// `n` falls as `id` rises, except `c` and `d`, which share n = 30.
const ITEMS: Item[] = [
  { id: "a", group: "x", n: 50 },
  { id: "b", group: "x", n: 40 },
  { id: "c", group: "y", n: 30 },
  { id: "d", group: "y", n: 30 },
  { id: "e", group: "y", n: 20 },
  { id: "f", group: "x", n: 10 },
];

const ids = (rows: Record<string, unknown>[]): unknown[] => rows.map((r) => r["id"]);

function getAll(fields: Partial<IdbGetAllPlan>): IdbGetAllPlan {
  return { meta: META, kind: "get-all", storeName: "items", ...fields };
}

function scan(fields: Partial<IdbCursorScanPlan>): IdbCursorScanPlan {
  return { meta: META, kind: "cursor-scan", storeName: "items", ...fields };
}

function scanWrite(fields: Partial<IdbScanWritePlan> & Pick<IdbScanWritePlan, "write">): IdbScanWritePlan {
  return { meta: META, kind: "scan-write", storeName: "items", ...fields };
}

let db: IDBDatabase;
beforeEach(async () => {
  db = await openItemsDb();
});
afterEach(() => db.close());

/** Every range shape, as `by-n` index keys: the descriptor and the `n` values it selects. */
const N_RANGES: ReadonlyArray<readonly [string, IdbKeyRangeDescriptor, number[]]> = [
  ["only", { kind: "only", key: 30 }, [30, 30]],
  ["only (no match)", { kind: "only", key: 35 }, []],
  ["lower, closed", { kind: "lower", key: 30 }, [30, 30, 40, 50]],
  ["lower, open", { kind: "lower", key: 30, open: true }, [40, 50]],
  ["upper, closed", { kind: "upper", key: 30 }, [10, 20, 30, 30]],
  ["upper, open", { kind: "upper", key: 30, open: true }, [10, 20]],
  ["bound, closed both", { kind: "bound", lower: 20, upper: 40 }, [20, 30, 30, 40]],
  ["bound, open lower", { kind: "bound", lower: 20, upper: 40, lowerOpen: true }, [30, 30, 40]],
  ["bound, open upper", { kind: "bound", lower: 20, upper: 40, upperOpen: true }, [20, 30, 30]],
  ["bound, open both", { kind: "bound", lower: 20, upper: 40, lowerOpen: true, upperOpen: true }, [30, 30]],
];

describe("toIdbKeyRange", () => {
  it.each([
    ["only", { kind: "only", key: 5 }, { lower: 5, upper: 5, lowerOpen: false, upperOpen: false }],
    ["lower, closed by default", { kind: "lower", key: 5 }, { lower: 5, upper: undefined, lowerOpen: false }],
    ["lower, open", { kind: "lower", key: 5, open: true }, { lower: 5, upper: undefined, lowerOpen: true }],
    ["upper, closed by default", { kind: "upper", key: 5 }, { lower: undefined, upper: 5, upperOpen: false }],
    ["upper, open", { kind: "upper", key: 5, open: true }, { lower: undefined, upper: 5, upperOpen: true }],
    [
      "bound, closed by default",
      { kind: "bound", lower: 1, upper: 9 },
      { lower: 1, upper: 9, lowerOpen: false, upperOpen: false },
    ],
    [
      "bound, open both",
      { kind: "bound", lower: 1, upper: 9, lowerOpen: true, upperOpen: true },
      { lower: 1, upper: 9, lowerOpen: true, upperOpen: true },
    ],
    [
      "bound with mixed flags",
      { kind: "bound", lower: 1, upper: 9, lowerOpen: true },
      { lower: 1, upper: 9, lowerOpen: true, upperOpen: false },
    ],
  ] satisfies ReadonlyArray<readonly [string, IdbKeyRangeDescriptor, Partial<IDBKeyRange>]>)(
    "%s",
    (_name, descriptor, expected) => {
      expect(toIdbKeyRange(descriptor)).toMatchObject(expected);
    }
  );

  it("takes compound keys as arrays", () => {
    expect(toIdbKeyRange({ kind: "only", key: ["x", 1] })).toMatchObject({ lower: ["x", 1], upper: ["x", 1] });
  });

  it("throws DataError when lower is above upper", () => {
    expect(() => toIdbKeyRange({ kind: "bound", lower: 9, upper: 1 })).toThrow(
      expect.objectContaining({ name: "DataError" })
    );
  });

  it("throws DataError for a value that is not a valid key", () => {
    expect(() => toIdbKeyRange({ kind: "only", key: Number.NaN })).toThrow(
      expect.objectContaining({ name: "DataError" })
    );
  });
});

describe("get-all", () => {
  it("reads the whole store in primary-key order by default", async () => {
    expect(ids(await executeIdbPlan(db, getAll({})))).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("reads the whole index in index order", async () => {
    // Equal keys come back in primary-key order.
    expect(ids(await executeIdbPlan(db, getAll({ indexName: "by-n" })))).toEqual(["f", "e", "c", "d", "b", "a"]);
  });

  it.each(N_RANGES)("reads an index range: %s", async (_name, range, expectedN) => {
    const rows = await executeIdbPlan(db, getAll({ indexName: "by-n", range }));
    expect(rows.map((r) => r["n"])).toEqual(expectedN);
  });

  it.each([
    ["only", { kind: "only", key: "c" }, ["c"]],
    ["lower, open", { kind: "lower", key: "d", open: true }, ["e", "f"]],
    ["upper, closed", { kind: "upper", key: "b" }, ["a", "b"]],
    ["bound, open both", { kind: "bound", lower: "b", upper: "e", lowerOpen: true, upperOpen: true }, ["c", "d"]],
  ] satisfies ReadonlyArray<readonly [string, IdbKeyRangeDescriptor, string[]]>)(
    "reads a store range: %s",
    async (_name, range, expected) => {
      expect(ids(await executeIdbPlan(db, getAll({ range })))).toEqual(expected);
    }
  );

  it("reads a prefix of a compound index with array bounds", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "bound", lower: ["y"], upper: ["y", []] };
    const rows = await executeIdbPlan(db, getAll({ indexName: "by-group-n", range }));
    expect(ids(rows)).toEqual(["e", "c", "d"]);
  });

  it("caps the rows with count", async () => {
    expect(ids(await executeIdbPlan(db, getAll({ count: 2 })))).toEqual(["a", "b"]);
    expect(ids(await executeIdbPlan(db, getAll({ indexName: "by-n", count: 2 })))).toEqual(["f", "e"]);
  });

  it("applies count after the range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "lower", key: 30 };
    expect(ids(await executeIdbPlan(db, getAll({ indexName: "by-n", range, count: 3 })))).toEqual(["c", "d", "b"]);
  });

  it("returns every row when count exceeds the matches", async () => {
    expect(await executeIdbPlan(db, getAll({ count: 100 }))).toHaveLength(ITEMS.length);
  });

  it("returns no rows for count 0", async () => {
    expect(await executeIdbPlan(db, getAll({ count: 0 }))).toEqual([]);
    expect(await executeIdbPlan(db, getAll({ indexName: "by-n", count: 0 }))).toEqual([]);
  });

  it("rejects an unknown index", async () => {
    await expect(executeIdbPlan(db, getAll({ indexName: "nope" }))).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

describe("cursor-scan", () => {
  it("walks an index in index order", async () => {
    expect(ids(await executeIdbPlan(db, scan({ indexName: "by-n" })))).toEqual(["f", "e", "c", "d", "b", "a"]);
  });

  it("walks the store in reverse with direction prev", async () => {
    expect(ids(await executeIdbPlan(db, scan({ direction: "prev" })))).toEqual(["f", "e", "d", "c", "b", "a"]);
  });

  it("walks an index in reverse with direction prev", async () => {
    // Equal keys come back in reverse primary-key order too.
    expect(ids(await executeIdbPlan(db, scan({ indexName: "by-n", direction: "prev" })))).toEqual([
      "a",
      "b",
      "d",
      "c",
      "e",
      "f",
    ]);
  });

  it.each(N_RANGES)("restricts an index walk to a range: %s", async (_name, range, expectedN) => {
    const rows = await executeIdbPlan(db, scan({ indexName: "by-n", range }));
    expect(rows.map((r) => r["n"])).toEqual(expectedN);
  });

  it.each(N_RANGES)("restricts a descending index walk to a range: %s", async (_name, range, expectedN) => {
    const rows = await executeIdbPlan(db, scan({ indexName: "by-n", range, direction: "prev" }));
    expect(rows.map((r) => r["n"])).toEqual([...expectedN].reverse());
  });

  it("restricts a store walk to a range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "bound", lower: "b", upper: "d", upperOpen: true };
    expect(ids(await executeIdbPlan(db, scan({ range })))).toEqual(["b", "c"]);
  });

  it("applies the filter inside the range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "lower", key: 30 };
    const rows = await executeIdbPlan(db, scan({ indexName: "by-n", range, filter: (r) => r["group"] === "y" }));
    expect(ids(rows)).toEqual(["c", "d"]);
  });

  it("returns the top rows of an index with take and direction prev", async () => {
    const rows = await executeIdbPlan(db, scan({ indexName: "by-n", direction: "prev", skip: 1, take: 2 }));
    expect(ids(rows)).toEqual(["b", "d"]);
  });

  describe("early stop", () => {
    /** A filter that records the ids of the rows the cursor visited. */
    function recordingFilter(): { visited: unknown[]; filter: (row: Record<string, unknown>) => boolean } {
      const visited: unknown[] = [];
      return {
        visited,
        filter: (row) => {
          visited.push(row["id"]);
          return true;
        },
      };
    }

    it("stops the cursor once take rows are collected", async () => {
      const { visited, filter } = recordingFilter();
      const rows = await executeIdbPlan(db, scan({ indexName: "by-n", direction: "prev", take: 2, filter }));
      expect(ids(rows)).toEqual(["a", "b"]);
      expect(visited).toEqual(["a", "b"]);
    });

    it("counts skipped rows as visited", async () => {
      const { visited, filter } = recordingFilter();
      await executeIdbPlan(db, scan({ skip: 2, take: 1, filter }));
      expect(visited).toEqual(["a", "b", "c"]);
    });

    it("visits every row when a comparator needs the whole range", async () => {
      const { visited, filter } = recordingFilter();
      await executeIdbPlan(db, scan({ take: 1, filter, comparator: () => 0 }));
      expect(visited).toHaveLength(ITEMS.length);
    });

    it("does not open a cursor for take 0", async () => {
      const { visited, filter } = recordingFilter();
      expect(await executeIdbPlan(db, scan({ take: 0, filter }))).toEqual([]);
      expect(visited).toEqual([]);
    });

    it("leaves the transaction able to commit, so the next op in a batch runs", async () => {
      const batch: IdbBatchPlan = {
        meta: META,
        kind: "batch",
        storeNames: ["items"],
        ops: [
          scan({ indexName: "by-n", take: 1 }),
          scanWrite({ write: "delete", range: { kind: "only", key: "a" } }),
          getAll({ count: 10 }),
        ] satisfies IdbAtomicPlan[],
      };
      const rows = await executeIdbPlan(db, batch);
      // First row of the index (f), the deleted row (a), then the five rows left in the store.
      expect(ids(rows)).toEqual(["f", "a", "b", "c", "d", "e", "f"]);
    });
  });

  it("rejects an unknown index", async () => {
    await expect(executeIdbPlan(db, scan({ indexName: "nope" }))).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

describe("scan-write", () => {
  async function storeIds(): Promise<unknown[]> {
    return ids(await executeIdbPlan(db, getAll({})));
  }

  it("updates only the rows in a store range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "bound", lower: "b", upper: "d" };
    const rows = await executeIdbPlan(db, scanWrite({ write: "put-merged", patch: { n: 0 }, range }));
    expect(ids(rows)).toEqual(["b", "c", "d"]);

    const all = await executeIdbPlan(db, getAll({}));
    expect(all.map((r) => r["n"])).toEqual([50, 0, 0, 0, 20, 10]);
  });

  it("deletes only the rows in an index range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "upper", key: 30, open: true };
    const rows = await executeIdbPlan(db, scanWrite({ write: "delete", indexName: "by-n", range }));
    expect(ids(rows)).toEqual(["f", "e"]);
    expect(await storeIds()).toEqual(["a", "b", "c", "d"]);
  });

  it("respects open and closed bounds", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "bound", lower: 20, upper: 40, lowerOpen: true, upperOpen: true };
    const rows = await executeIdbPlan(db, scanWrite({ write: "delete", indexName: "by-n", range }));
    expect(ids(rows)).toEqual(["c", "d"]);
  });

  it("walks the index in index order, so take picks the lowest keys", async () => {
    const rows = await executeIdbPlan(db, scanWrite({ write: "delete", indexName: "by-n", take: 2 }));
    expect(ids(rows)).toEqual(["f", "e"]);
    expect(await storeIds()).toEqual(["a", "b", "c", "d"]);
  });

  describe("when the patch moves rows forward in the index", () => {
    // n 45 sorts after the entries of f, e, c, d and b (10 to 40) but before a (50), so the cursor
    // reaches each of those rows a second time at its new entry.
    const patch = { n: 45 };
    const expectedIds = ["f", "e", "c", "d", "b", "a"];

    it("writes each row once", async () => {
      const rows = await executeIdbPlan(db, scanWrite({ write: "put-merged", patch, indexName: "by-n" }));
      expect(ids(rows)).toEqual(expectedIds);
      expect((await executeIdbPlan(db, getAll({}))).map((r) => r["n"])).toEqual([45, 45, 45, 45, 45, 45]);
    });

    it("counts each row once towards take", async () => {
      const rows = await executeIdbPlan(db, scanWrite({ write: "put-merged", patch, indexName: "by-n", take: 6 }));
      expect(ids(rows)).toEqual(expectedIds);
    });
  });

  it("applies take inside the range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "lower", key: 30 };
    const rows = await executeIdbPlan(
      db,
      scanWrite({ write: "put-merged", patch: { n: 0 }, indexName: "by-n", range, take: 1 })
    );
    expect(ids(rows)).toEqual(["c"]);
  });

  it("applies the filter inside the range", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "lower", key: 30 };
    const filter = (row: Record<string, unknown>) => row["group"] === "x";
    const rows = await executeIdbPlan(db, scanWrite({ write: "delete", indexName: "by-n", range, filter }));
    expect(ids(rows)).toEqual(["b", "a"]);
  });

  it("writes nothing when the range matches no rows", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "only", key: 35 };
    expect(await executeIdbPlan(db, scanWrite({ write: "delete", indexName: "by-n", range }))).toEqual([]);
    expect(await storeIds()).toHaveLength(ITEMS.length);
  });

  it("writes nothing for take 0", async () => {
    expect(await executeIdbPlan(db, scanWrite({ write: "delete", take: 0 }))).toEqual([]);
    expect(await storeIds()).toHaveLength(ITEMS.length);
  });

  it("rejects an unknown index", async () => {
    await expect(executeIdbPlan(db, scanWrite({ write: "delete", indexName: "nope" }))).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});

describe("count and keys ranges", () => {
  it("count takes a descriptor", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "lower", key: 30, open: true };
    const rows = await executeIdbPlan(db, { meta: META, kind: "count", storeName: "items", indexName: "by-n", range });
    expect(rows).toEqual([{ count: 2 }]);
  });

  it("keys takes a descriptor", async () => {
    const range: IdbKeyRangeDescriptor = { kind: "upper", key: 20 };
    const rows = await executeIdbPlan(db, { meta: META, kind: "keys", storeName: "items", indexName: "by-n", range });
    expect(rows).toEqual([{ key: "f" }, { key: "e" }]);
  });
});
