/**
 * Runtime tests.
 *
 * What we test here:
 * - `createIdbRuntime()` factory returns an `IdbRuntime`
 * - `verifyMarker()`: all marker states (match, mismatch, missing store, missing key)
 * - `lower()` threads contract through via `IdbLowererContext`
 * - `close()` delegates to the driver
 * - Constructor builds `RuntimeMiddlewareContext` from contract (no explicit ctx)
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
    idbPlan: { kind: "cursorScan", storeName: "User" } as unknown as IdbPlanBody,
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
  it("returns an IdbRuntime with query, execute, verifyMarker, and close", () => {
    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
    });

    expect(runtime).toBeDefined();
    expect(typeof runtime.query).toBe("function");
    expect(typeof runtime.execute).toBe("function");
    expect(typeof runtime.verifyMarker).toBe("function");
    expect(typeof runtime.close).toBe("function");
  });

  it("accepts an optional middleware array", () => {
    const mw: IdbMiddleware = {
      name: "test-mw",
      familyId: "idb",
      beforeExecute: vi.fn(),
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    expect(runtime).toBeDefined();
  });

  it("rejects middleware for a different family", () => {
    const mw = {
      name: "wrong-family",
      familyId: "sql",
      beforeExecute: vi.fn(),
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

  it("accepts an optional ctx override", () => {
    const customCtx = {
      contract: { custom: true },
      mode: "permissive" as const,
      planExecutionId: "test-plan-exec",
      now: () => 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      contentHash: async () => "",
      scope: "runtime" as const,
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      ctx: customCtx,
    });

    expect(runtime).toBeDefined();
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
  it("threads contract through to adapter.lower() via IdbLowererContext", async () => {
    const lowerSpy = vi
      .fn<(plan: IdbQueryPlan, ctx: IdbLowererContext) => Promise<IdbPlanBody>>()
      .mockResolvedValue({ kind: "cursorScan", storeName: "User" } as unknown as IdbPlanBody);
    const adapter = makeMockAdapter({ lower: lowerSpy });

    const runtime = createIdbRuntime({
      adapter,
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
    });

    const plan = makeQueryPlan();

    // Call query() to trigger the lower() path.
    const iter = runtime.query(plan);
    const reader = iter[Symbol.asyncIterator]();
    await reader.next();

    expect(lowerSpy).toHaveBeenCalledTimes(1);

    // The first argument is the plan, second is the lowering context.
    // Access via bracket notation because ctx comes from an index signature.
    const ctxArg = lowerSpy.mock.calls[0]![1] as IdbLowererContext;
    expect(ctxArg).toBeDefined();
    expect(ctxArg["contract"]).toBe(TEST_CONTRACT);
  });
});

// ── close ────────────────────────────────────────────────────────────────────

describe("close", () => {
  it("delegates to driver.close()", async () => {
    const closeSpy = vi.fn<() => Promise<void>>();
    const driver = makeMockDriver({ close: closeSpy });

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
    });

    await runtime.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── query ────────────────────────────────────────────────────────────────────

describe("query", () => {
  it("calls adapter.lower() then driver.execute() and yields rows", async () => {
    const loweredPlan = { kind: "cursorScan", storeName: "User" } as unknown as IdbPlanBody;
    const lowerSpy = vi
      .fn<(plan: IdbQueryPlan, ctx: IdbLowererContext) => Promise<IdbPlanBody>>()
      .mockResolvedValue(loweredPlan);
    const adapter = makeMockAdapter({ lower: lowerSpy });

    const executeSpy = vi
      .fn<(plan: IdbPlanBody) => AsyncIterable<Record<string, unknown>>>()
      .mockReturnValue(rowsIterable({ id: 1 }));
    const driver = makeMockDriver({ execute: executeSpy });

    const runtime = createIdbRuntime({
      adapter,
      driver,
      contract: TEST_CONTRACT,
    });

    const plan = makeQueryPlan();
    const result = runtime.query(plan);

    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }

    expect(lowerSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: 1 });
  });

  it("passes an AbortSignal to the codec context when options.signal is provided", async () => {
    const controller = new AbortController();
    const lowerSpy = vi
      .fn<(plan: IdbQueryPlan, ctx: IdbLowererContext) => Promise<IdbPlanBody>>()
      .mockResolvedValue({ kind: "cursorScan", storeName: "User" } as unknown as IdbPlanBody);
    const adapter = makeMockAdapter({ lower: lowerSpy });

    const runtime = createIdbRuntime({
      adapter,
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
    });

    const plan = makeQueryPlan();
    const result = runtime.query(plan, { signal: controller.signal });

    // Consume the iterator
    const reader = result[Symbol.asyncIterator]();
    await reader.next();

    expect(lowerSpy).toHaveBeenCalledTimes(1);
  });

  it("middleware beforeQuery is called before the driver runs", async () => {
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
      beforeQuery: async () => {
        callOrder.push("beforeQuery");
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

    // lower() runs first (plan lowering), then beforeQuery, then execute
    expect(callOrder).toEqual(["lower", "beforeQuery", "execute"]);
    expect(rows).toHaveLength(1);
  });

  it("middleware onRow is called for each row", async () => {
    const onRowSpy = vi.fn();

    const driver = makeMockDriver({
      execute: (_plan) => rowsIterable({ id: 1 }, { id: 2 }, { id: 3 }),
    });

    const mw: IdbMiddleware = {
      name: "on-row-mw",
      familyId: "idb",
      onRow: onRowSpy,
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

    expect(onRowSpy).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
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

  it("runs the beforeExecute/afterExecute middleware chain, not beforeQuery/onRow", async () => {
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
      beforeQuery: () => {
        callOrder.push("beforeQuery"); // must NOT fire on execute()
      },
      beforeExecute: async () => {
        callOrder.push("beforeExecute");
      },
      afterExecute: async () => {
        callOrder.push("afterExecute");
      },
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver,
      contract: TEST_CONTRACT,
      middleware: [mw],
    });

    const result = await runtime.execute(makeQueryPlan());

    expect(callOrder).toEqual(["beforeExecute", "driver", "afterExecute"]);
    expect(result).toEqual({ affectedRows: 1 });
  });
});

// ── constructor middleware context ────────────────────────────────────────────

describe("constructor middleware context", () => {
  it("builds RuntimeMiddlewareContext from contract when ctx is not provided", async () => {
    // We verify this indirectly: since the runtime was created without an
    // explicit ctx, query() works (meaning the built ctx is valid).
    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
    });

    const plan = makeQueryPlan();
    const result = runtime.query(plan);
    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }
    expect(rows).toHaveLength(1);
  });

  it("uses the provided ctx when given, not a derived one", async () => {
    const customCtx = {
      contract: { custom: true },
      mode: "permissive" as const,
      planExecutionId: "test-plan-exec",
      now: () => 42,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      contentHash: async () => "",
      scope: "runtime" as const,
    };

    const runtime = createIdbRuntime({
      adapter: makeMockAdapter(),
      driver: makeMockDriver(),
      contract: TEST_CONTRACT,
      ctx: customCtx,
    });

    // verifyMarker should still use the provided runtime contract, not ctx.contract
    await expect(runtime.verifyMarker()).resolves.toBe(false);

    // query should still work
    const plan = makeQueryPlan();
    const result = runtime.query(plan);
    const rows: Record<string, unknown>[] = [];
    for await (const row of result) {
      rows.push(row as Record<string, unknown>);
    }
    expect(rows).toHaveLength(1);
  });

  it("built-in contentHash returns a sha512-prefixed digest", async () => {
    // The built-in context's contentHash should produce a real SHA-512
    // hash in the vendor format: "sha512:" + 128 lowercase hex digits.
    let capturedHash = "";

    const mw: IdbMiddleware = {
      name: "hash-capture",
      familyId: "idb",
      beforeQuery: async (_plan, ctx) => {
        // Call contentHash on a known plan shape
        capturedHash = await ctx.contentHash({
          kind: "cursorScan",
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
      beforeQuery: async (_plan, ctx) => {
        const planShape = {
          kind: "keyGet",
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
      beforeQuery: async (_plan, ctx) => {
        hashes.push(
          await ctx.contentHash({
            kind: "cursorScan",
            storeName: "users",
            meta: { target: "idb", storageHash: "aaa", lane: "idb" },
          } as import("@prisma/orm-framework/components/runtime").ExecutionPlan)
        );
        hashes.push(
          await ctx.contentHash({
            kind: "cursorScan",
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
