/**
 * Runtime tests.
 *
 * What we test here:
 * - `createIdbRuntime()` factory returns an `IdbRuntime`
 * - `verifyMarker()`: all marker states (match, mismatch, missing store, missing key)
 * - `lower()` threads contract through via `IdbLowererContext`
 * - `close()` delegates to the driver
 * - Constructor builds `ActivityContextFields` from contract (no explicit ctx)
 * - Constructor uses the provided ctx when given
 * - `query()` calls through the RuntimeCore chain (adapter → driver), rows out
 * - `execute()` calls through the same chain but resolves `{ affectedRows }`
 *
 * Isolation strategy: all driver and adapter dependencies are mocked.
 * No real IndexedDB is involved (unlike driver-idb tests which use fake-indexeddb).
 */
import type { IdbLowererContext, IdbRuntimeAdapterInstance, IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type {
  IdbMarkerRecord,
  IdbPlanBody,
  IdbRuntimeDriverInstance,
  IdbTransactionScope,
} from "@prisma-idb/driver-idb/runtime";
import { IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { IdbMiddleware } from "../src/idb-middleware";
import { createIdbRuntime } from "../src/idb-runtime";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_CONTRACT = {
  storage: { storageHash: "abc123" },
} as const;

const NO_STORAGE_CONTRACT = {} as const;

/**
 * Minimal `IdbQueryPlan` suitable for test assertions.
 */
function makeQueryPlan(overrides?: Partial<IdbQueryPlan>): IdbQueryPlan {
  return {
    meta: { target: "idb", storageHash: "abc123", lane: "idb" },
    idbPlan: {
      meta: { target: "idb", storageHash: "abc123", lane: "idb" },
      kind: "cursor-scan",
      storeName: "User",
    } satisfies IdbPlanBody,
    ...overrides,
  };
}

/**
 * Minimal `IdbMarkerRecord`.
 */
function makeMarker(overrides?: Partial<IdbMarkerRecord>): IdbMarkerRecord {
  return {
    storageHash: "abc123",
    profileHash: "prof1",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a stub `IDBDatabase` for the mock driver's required `db` property.
 * Only used to satisfy the type — never accessed at runtime.
 */
function stubDb(): IDBDatabase {
  return {} as IDBDatabase;
}

/** Helper to create a simple async iterable yielding given rows. */
function rowsIterable(...rows: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]: () =>
      (async function* () {
        yield* rows;
      })(),
  };
}

// ── Mock driver factory ──────────────────────────────────────────────────────

interface MockDriverOptions {
  readMarker?: () => Promise<IdbMarkerRecord | null>;
  execute?: (plan: IdbPlanBody) => AsyncIterable<Record<string, unknown>>;
  close?: () => Promise<void>;
  transaction?: (storeNames: string[], mode?: IDBTransactionMode) => Promise<IdbTransactionScope>;
}

function makeMockDriver(options: MockDriverOptions = {}): IdbRuntimeDriverInstance {
  // Tests that don't exercise the transaction path get a stub that rejects.
  // Calling `transaction()` on this mock would indicate a regression in the
  // test's scoping assumptions, not a runtime concern.
  const defaultTransaction = (): Promise<IdbTransactionScope> => {
    throw new Error("Mock driver does not implement transaction(); pass `options.transaction` to enable.");
  };
  return {
    familyId: "idb" as const,
    targetId: "idb" as const,
    db: Promise.resolve(stubDb()),
    readMarker: options.readMarker ?? (async () => null),
    execute: options.execute ?? ((_plan: IdbPlanBody) => rowsIterable({ id: 1 })),
    close: options.close ?? (async () => undefined),
    transaction: options.transaction ?? defaultTransaction,
  } satisfies IdbRuntimeDriverInstance;
}

// ── Mock adapter factory ─────────────────────────────────────────────────────

interface MockAdapterOptions {
  lower?: (plan: IdbQueryPlan, ctx: IdbLowererContext) => Promise<IdbPlanBody>;
}

function makeMockAdapter(options: MockAdapterOptions = {}): IdbRuntimeAdapterInstance {
  return {
    familyId: "idb" as const,
    targetId: "idb" as const,
    lower: options.lower ?? (async (plan: IdbQueryPlan) => plan.idbPlan),
  } satisfies IdbRuntimeAdapterInstance;
}

// ── createIdbRuntime ─────────────────────────────────────────────────────────

describe("createIdbRuntime", () => {
  it("rejects middleware for a different family", () => {
    const mw = {
      name: "wrong-family",
      familyId: "sql",
      beforeEncode: vi.fn(),
    } as unknown as IdbMiddleware;

    expect(() =>
      createIdbRuntime({
        adapter: makeMockAdapter(),
        driver: makeMockDriver(),
        contract: TEST_CONTRACT,
        middleware: [mw],
      })
    ).toThrow(/requires family 'sql'.*family 'idb'/i);
  });
});

// ── verifyMarker ─────────────────────────────────────────────────────────────

describe("verifyMarker", () => {
  it("returns false when readMarker returns null (no marker store)", async () => {
    const driver = makeMockDriver({
      readMarker: async () => null,
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    await expect(runtime.verifyMarker()).resolves.toBe(false);
  });

  it("returns true when marker storageHash matches contract", async () => {
    const driver = makeMockDriver({
      readMarker: async () => makeMarker({ storageHash: "abc123" }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    await expect(runtime.verifyMarker()).resolves.toBe(true);
  });

  it("returns false when marker storageHash differs from contract", async () => {
    const driver = makeMockDriver({
      readMarker: async () => makeMarker({ storageHash: "mismatched" }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    await expect(runtime.verifyMarker()).resolves.toBe(false);
  });

  it("returns false when contract has no storage.storageHash", async () => {
    const driver = makeMockDriver({
      readMarker: async () => makeMarker({ storageHash: "abc123" }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: NO_STORAGE_CONTRACT,
    });

    await expect(runtime.verifyMarker()).resolves.toBe(false);
  });

  it("returns false when contract is missing the storage key entirely", async () => {
    const driver = makeMockDriver({
      readMarker: async () => makeMarker({ storageHash: "abc123" }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: {},
    });

    await expect(runtime.verifyMarker()).resolves.toBe(false);
  });
});

// ── lower() contract threading ───────────────────────────────────────────────

describe("lower", () => {
  it("supplies the contract needed by a lowerer to resolve the query", async () => {
    const adapter = makeMockAdapter({
      lower: async (plan, ctx) => ({
        meta: plan.meta,
        kind: "key-get",
        storeName: "User",
        key: (ctx.contract as typeof TEST_CONTRACT).storage.storageHash,
      }),
    });
    const driver = makeMockDriver({
      execute: (plan) => rowsIterable({ key: plan.kind === "key-get" ? plan.key : null }),
    });
    const runtime = createIdbRuntime({ adapter, driver, contract: TEST_CONTRACT });
    const rows = [];
    for await (const row of runtime.query(makeQueryPlan())) rows.push(row);
    expect(rows).toEqual([{ key: "abc123" }]);
  });
});

// ── close ────────────────────────────────────────────────────────────────────

describe("close", () => {
  it("settles close with a driver resource-release failure", async () => {
    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver({
        close: async () => {
          throw new Error("Cannot release database");
        },
      }),
      contract: TEST_CONTRACT,
    });
    await expect(runtime.close()).rejects.toThrow("Cannot release database");
  });
});

// ── query ────────────────────────────────────────────────────────────────────

describe("query", () => {
  it("returns the driver's rows through the public query stream", async () => {
    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver({ execute: () => rowsIterable({ id: 1 }) }),
      contract: TEST_CONTRACT,
    });
    const rows = [];
    for await (const row of runtime.query(makeQueryPlan())) rows.push(row);
    expect(rows).toEqual([{ id: 1 }]);
  });
  it("makes cancellation state available to the query lowerer", async () => {
    const controller = new AbortController();
    let state: boolean | undefined;
    const adapter = makeMockAdapter({
      lower: async (plan, ctx) => {
        controller.abort();
        state = ctx.signal?.aborted;
        return plan.idbPlan;
      },
    });
    const runtime = createIdbRuntime({ adapter, driver: makeMockDriver(), contract: TEST_CONTRACT });
    for await (const _row of runtime.query(makeQueryPlan(), { signal: controller.signal })) {
      /* Drain the public result. */
    }
    expect(state).toBe(true);
  });

  it("middleware beforeEncode is called before the driver runs", async () => {
    const callOrder: string[] = [];

    const adapter = makeMockAdapter({
      lower: async (plan) => {
        callOrder.push("lower");
        return plan.idbPlan;
      },
    });

    const driver = makeMockDriver({
      execute: (_plan) => {
        callOrder.push("execute");
        return rowsIterable({ id: 1 });
      },
    });

    const mw: IdbMiddleware = {
      name: "before-query-mw",
      familyId: "idb",
      beforeEncode: async () => {
        callOrder.push("beforeEncode");
      },
    };

    const runtime = createIdbRuntime({
      adapter,
      driver,
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const plan = makeQueryPlan();
    const result = runtime.query(plan);

    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }

    // lower() runs first (plan lowering), then beforeEncode, then execute
    expect(callOrder).toEqual(["lower", "beforeEncode", "execute"]);
    expect(rows).toHaveLength(1);
  });

  it("notifies row middleware of the same rows returned to the caller", async () => {
    const observed: unknown[] = [];

    const driver = makeMockDriver({
      execute: (_plan) => rowsIterable({ id: 1 }, { id: 2 }, { id: 3 }),
    });

    const mw: IdbMiddleware = {
      name: "on-row-mw",
      familyId: "idb",
      onRow: async (row) => {
        observed.push(row);
      },
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const plan = makeQueryPlan();
    const result = runtime.query(plan);

    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(observed).toEqual(rows);
  });
});

// ── execute (statement path) ─────────────────────────────────────────────────

describe("execute", () => {
  it("resolves { affectedRows } by draining the driver's row stream", async () => {
    const driver = makeMockDriver({
      execute: (_plan) => rowsIterable({ id: 1 }, { id: 2 }, { id: 3 }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    const result = await runtime.execute(makeQueryPlan());

    expect(result).toEqual({ affectedRows: 3 });
  });

  it("resolves { affectedRows: 0 } when the driver yields no rows", async () => {
    const driver = makeMockDriver({
      execute: (_plan) => rowsIterable(),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    const result = await runtime.execute(makeQueryPlan());

    expect(result).toEqual({ affectedRows: 0 });
  });

  it("resolves { affectedRows: 1 } for a delete plan that matched a key", async () => {
    // Mirrors driver-idb's execute/ops.ts::execDelete, which now walks a
    // cursor over the delete plan's key/range and echoes each row it
    // actually deletes (rather than resolving `[]` unconditionally) — so
    // draining and counting here gives the real per-op affected count.
    const driver = makeMockDriver({
      execute: (_plan) => rowsIterable({ id: "user-1" }), // the deleted row, echoed
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    const deletePlan = makeQueryPlan({
      idbPlan: { kind: "delete", storeName: "User", key: "user-1" } as unknown as IdbPlanBody,
    });
    const result = await runtime.execute(deletePlan);

    expect(result).toEqual({ affectedRows: 1 });
  });

  it("resolves { affectedRows: 0 } for a delete plan that matched no key", async () => {
    const driver = makeMockDriver({
      execute: (_plan) => rowsIterable(), // no key matched — nothing echoed
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    const deletePlan = makeQueryPlan({
      idbPlan: { kind: "delete", storeName: "User", key: "does-not-exist" } as unknown as IdbPlanBody,
    });
    const result = await runtime.execute(deletePlan);

    expect(result).toEqual({ affectedRows: 0 });
  });

  it("runs beforeEncode and activityEnded around execute(), not onRow", async () => {
    const callOrder: string[] = [];

    const driver = makeMockDriver({
      execute: (_plan) => {
        callOrder.push("driver");
        return rowsIterable({ id: 1 });
      },
    });

    const mw: IdbMiddleware = {
      name: "before-exec-mw",
      familyId: "idb",
      beforeEncode: async () => {
        callOrder.push("beforeEncode");
      },
      onRow: async () => {
        callOrder.push("onRow"); // must NOT fire on execute()
      },
      activityEnded: async (_activity, result) => {
        callOrder.push(`activityEnded:${result.kind === "statement" ? result.returns : result.kind}`);
      },
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const result = await runtime.execute(makeQueryPlan());

    expect(callOrder).toEqual(["beforeEncode", "driver", "activityEnded:stats"]);
    expect(result).toEqual({ affectedRows: 1 });
  });
});

// ── constructor middleware context ────────────────────────────────────────────

describe("constructor middleware context", () => {
  it("uses the provided ctx when given, not a derived one", async () => {
    const customCtx = {
      contract: { custom: true },
      mode: "permissive" as const,
      now: () => 42,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      contentHash: async () => "",
      scope: "runtime" as const,
    };

    let observed: unknown;
    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver({ readMarker: async () => makeMarker() }),
      contract: TEST_CONTRACT,
      ctx: customCtx,
      middleware: [
        {
          name: "observe-context",
          familyId: "idb",
          beforeEncode: async (_plan, ctx) => {
            observed = { contract: ctx.contract, now: ctx.now(), mode: ctx.mode, scope: ctx.scope };
          },
        },
      ],
    });

    // verifyMarker should still use the provided runtime contract, not ctx.contract
    await expect(runtime.verifyMarker()).resolves.toBe(true);

    // query should still work
    const plan = makeQueryPlan();
    const result = runtime.query(plan);
    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }
    expect(rows).toHaveLength(1);
    expect(observed).toEqual({ contract: { custom: true }, now: 42, mode: "permissive", scope: "runtime" });
  });

  it("built-in contentHash returns a sha512-prefixed digest", async () => {
    // The built-in context's contentHash should produce a real SHA-512
    // hash in the vendor format: "sha512:" + 128 lowercase hex digits.
    let capturedHash = "";

    const mw: IdbMiddleware = {
      name: "hash-capture",
      familyId: "idb",
      beforeEncode: async (_plan, ctx) => {
        // Call contentHash on a known plan shape
        capturedHash = await ctx.contentHash({
          kind: "cursor-scan",
          storeName: "User",
          meta: { target: "idb", storageHash: "abc123", lane: "idb" },
        } as unknown as import("@prisma/orm-framework/components/runtime").ExecutionPlan);
      },
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const plan = makeQueryPlan();
    const result = runtime.query(plan);
    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }

    expect(capturedHash).toMatch(/^sha512:[0-9a-f]{128}$/);
    expect(capturedHash).toHaveLength(135); // "sha512:" + 128 hex
    expect(rows).toHaveLength(1);
  });

  it("built-in contentHash is deterministic for the same plan", async () => {
    const hashes: string[] = [];

    const mw: IdbMiddleware = {
      name: "hash-determinism",
      familyId: "idb",
      beforeEncode: async (_plan, ctx) => {
        const planShape = {
          kind: "key-get",
          storeName: "posts",
          key: "post-1",
          meta: { target: "idb", storageHash: "def456", lane: "idb" },
        } as unknown as import("@prisma/orm-framework/components/runtime").ExecutionPlan;
        hashes.push(await ctx.contentHash(planShape));
        hashes.push(await ctx.contentHash(planShape));
      },
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const result = runtime.query(makeQueryPlan());
    const reader = result[Symbol.asyncIterator]();
    await reader.next();

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("built-in contentHash differs for different plans", async () => {
    const hashes: string[] = [];

    const mw: IdbMiddleware = {
      name: "hash-distinct",
      familyId: "idb",
      beforeEncode: async (_plan, ctx) => {
        hashes.push(
          await ctx.contentHash({
            kind: "cursor-scan",
            storeName: "users",
            meta: { target: "idb", storageHash: "aaa", lane: "idb" },
          } as import("@prisma/orm-framework/components/runtime").ExecutionPlan)
        );
        hashes.push(
          await ctx.contentHash({
            kind: "cursor-scan",
            storeName: "posts",
            meta: { target: "idb", storageHash: "bbb", lane: "idb" },
          } as import("@prisma/orm-framework/components/runtime").ExecutionPlan)
        );
      },
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const result = runtime.query(makeQueryPlan());
    const reader = result[Symbol.asyncIterator]();
    await reader.next();

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

// ── built-in contentHash: plan identity ──────────────────────────────────────

describe("built-in contentHash plan identity", () => {
  type ExecPlan = import("@prisma/orm-framework/components/runtime").ExecutionPlan;

  /** Runs one query and returns the built-in `contentHash` the middleware sees. */
  async function captureContentHash(): Promise<(plan: Record<string, unknown>) => Promise<string>> {
    let hash: ((plan: ExecPlan) => Promise<string>) | undefined;
    const mw: IdbMiddleware = {
      name: "hash-capture",
      familyId: "idb",
      beforeEncode: async (_plan, ctx) => {
        hash = ctx.contentHash;
      },
    };
    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      middleware: [mw],
    });
    await runtime.query(makeQueryPlan());
    return (plan) => hash!(plan as unknown as ExecPlan);
  }

  const range = (lower: unknown, upper: unknown) => ({ lower, upper, lowerOpen: false, upperOpen: true });

  it("never reuses a hash for an opaque function, even the same reference", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "cursor-scan", storeName: "users" };

    const plan = { ...base, filter: () => true };
    expect(await contentHash(plan)).not.toBe(await contentHash(base));
    expect(await contentHash(plan)).not.toBe(await contentHash(plan));
  });

  it("keeps only the storage hash from meta", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "key-get", storeName: "users", key: 1 };

    const a = await contentHash({ ...base, meta: { storageHash: "h1", lane: "idb" } });
    const b = await contentHash({ ...base, meta: { storageHash: "h1", lane: "other" } });
    const c = await contentHash({ ...base, meta: { storageHash: "h2", lane: "idb" } });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("hashes a delete key range by its bounds", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "delete", storeName: "users" };

    const a = await contentHash({ ...base, key: range(18, 65) });
    const b = await contentHash({ ...base, key: range(18, 65) });
    const c = await contentHash({ ...base, key: range(18, 66) });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("hashes a real key range the same as a plain object with the same bounds", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "delete", storeName: "users" };

    // Normalization turns the key-range class instance into a plain object, which canonicalStringify accepts.
    const real = await contentHash({ ...base, key: IDBKeyRange.bound(18, 65, false, true) });
    const plain = await contentHash({ ...base, key: range(18, 65) });
    const other = await contentHash({ ...base, key: IDBKeyRange.bound(18, 66, false, true) });

    expect(real).toBe(plain);
    expect(real).not.toBe(other);
  });

  it("ignores extra properties on a duck-typed key range", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "delete", storeName: "users" };

    const withExtra = await contentHash({ ...base, key: { ...range(18, 65), note: "ignored" } });

    expect(withExtra).toBe(await contentHash({ ...base, key: range(18, 65) }));
  });

  it("hashes delete key ranges that differ only in open flags differently", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "delete", storeName: "users" };

    const lowerOpen = await contentHash({ ...base, key: IDBKeyRange.bound(18, 65, true, true) });
    const lowerClosed = await contentHash({ ...base, key: IDBKeyRange.bound(18, 65, false, true) });
    const upperClosed = await contentHash({ ...base, key: IDBKeyRange.bound(18, 65, false, false) });

    expect(new Set([lowerOpen, lowerClosed, upperClosed]).size).toBe(3);
  });

  it("hashes range descriptors by value, including open flags", async () => {
    const contentHash = await captureContentHash();
    const base = { kind: "get-all", storeName: "users", indexName: "by_age" };
    const bound = (lowerOpen: boolean) => ({ kind: "bound", lower: 18, upper: 65, lowerOpen });

    const a = await contentHash({ ...base, range: bound(false) });
    const b = await contentHash({ ...base, range: bound(false) });
    const open = await contentHash({ ...base, range: bound(true) });
    const other = await contentHash({ ...base, range: { kind: "only", key: 18 } });

    expect(a).toBe(b);
    expect(new Set([a, open, other]).size).toBe(3);
  });
});

// ── verifyMarker with varying contracts ──────────────────────────────────────

describe("verifyMarker edge cases", () => {
  it("handles a contract where storage.storageHash is a number (type mismatch)", async () => {
    const driver = makeMockDriver({
      readMarker: async () => makeMarker({ storageHash: "abc123" }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      // storageHash is a number, not a string
      contract: { storage: { storageHash: 123 } },
    });

    // typeof 123 !== "string" → returns false
    await expect(runtime.verifyMarker()).resolves.toBe(false);
  });

  it("handles a contract where storage is not an object", async () => {
    const driver = makeMockDriver({
      readMarker: async () => makeMarker({ storageHash: "abc123" }),
    });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: { storage: "not-an-object" },
    });

    await expect(runtime.verifyMarker()).resolves.toBe(false);
  });
});
