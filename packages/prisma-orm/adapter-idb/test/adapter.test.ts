/**
 * Adapter tests.
 *
 * Tests the IdbAdapter.lower() implementation against a set of IdbQueryPlan
 * fixtures. Since lower() is a structural passthrough (all idb/* codecs are
 * identity transforms), the primary assertions are:
 *   - lower() returns the `idbPlan` field unchanged.
 *   - lower() returns a Promise (async contract).
 *   - The returned plan is the exact same reference as plan.idbPlan.
 *   - IdbAdapterDescriptor.create() no longer throws.
 *
 * Coverage:
 *   lower() — key-get passthrough
 *   lower() — cursor-scan passthrough
 *   lower() — put passthrough
 *   lower() — update passthrough
 *   lower() — delete passthrough
 *   lower() — batch passthrough
 *   lower() — signal threading (ctx with AbortSignal)
 *   create() — descriptor wires up a real IdbAdapter (no throw)
 */
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import { IdbAdapter } from "../src/core/idb-adapter";
import type { IdbQueryPlan } from "../src/core/idb-query-plan";
import type { IdbLowererContext } from "../src/core/runtime-adapter-instance";
import idbRuntimeAdapterDescriptor from "../src/exports/runtime";
import { emptyCodecLookup } from "@prisma/orm-framework/components/codec";
import type {
  IdbBatchPlan,
  IdbCursorScanPlan,
  IdbDeletePlan,
  IdbKeyGetPlan,
  IdbPutPlan,
  IdbUpdatePlan,
} from "@prisma-idb/driver-idb/runtime";

// ── Helpers ──────────────────────────────────────────────────────────────────

const META = { target: "idb", storageHash: "test-hash", lane: "test" } as const;

function makePlan<P extends IdbQueryPlan["idbPlan"]>(idbPlan: P): IdbQueryPlan {
  return { meta: META, idbPlan };
}

const adapter = new IdbAdapter(emptyCodecLookup);

/** Minimal lowering context with a stub contract for testing. */
const TEST_CTX: IdbLowererContext = {
  contract: { storage: { storageHash: "test-hash", stores: {} } },
};

// ── lower() passthrough ───────────────────────────────────────────────────────

describe("IdbAdapter.lower() — passthrough", () => {
  it("returns a Promise", () => {
    const plan = makePlan({
      meta: META,
      kind: "key-get",
      storeName: "users",
      key: "u1",
    } satisfies IdbKeyGetPlan);
    const result = adapter.lower(plan, TEST_CTX);
    expect(result).toBeInstanceOf(Promise);
  });

  it("key-get: returns the exact idbPlan reference", async () => {
    const idbPlan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u1" };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });

  it("cursor-scan: returns the exact idbPlan reference", async () => {
    const idbPlan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "posts",
      filter: (row) => Boolean(row["published"]),
      take: 10,
    };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });

  it("put: returns the exact idbPlan reference", async () => {
    const idbPlan: IdbPutPlan = {
      meta: META,
      kind: "put",
      storeName: "users",
      record: { id: "u1", name: "Alice" },
    };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });

  it("update: returns the exact idbPlan reference", async () => {
    const idbPlan: IdbUpdatePlan = {
      meta: META,
      kind: "update",
      storeName: "users",
      key: "u1",
      patch: { name: "Alice Updated" },
    };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });

  it("delete: returns the exact idbPlan reference", async () => {
    const idbPlan: IdbDeletePlan = {
      meta: META,
      kind: "delete",
      storeName: "users",
      key: "u1",
    };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });

  it("batch: returns the exact idbPlan reference", async () => {
    const idbPlan: IdbBatchPlan = {
      meta: META,
      kind: "batch",
      storeNames: ["users", "posts"],
      ops: [
        { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } },
        { meta: META, kind: "delete", storeName: "posts", key: "p1" },
      ],
    };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });

  it("threads ctx with AbortSignal without throwing", async () => {
    const controller = new AbortController();
    const ctx: IdbLowererContext = {
      signal: controller.signal,
      contract: { storage: { storageHash: "test-hash", stores: {} } },
    };
    const idbPlan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u99" };
    const plan = makePlan(idbPlan);
    const result = await adapter.lower(plan, ctx);
    expect(result).toBe(idbPlan);
  });
});

// ── descriptor.create() ───────────────────────────────────────────────────────

describe("idbRuntimeAdapterDescriptor.create()", () => {
  it("does not throw", () => {
    const fakeStack = {} as Parameters<typeof idbRuntimeAdapterDescriptor.create>[0];
    expect(() => idbRuntimeAdapterDescriptor.create(fakeStack)).not.toThrow();
  });

  it("returns an instance with familyId and targetId", () => {
    const fakeStack = {} as Parameters<typeof idbRuntimeAdapterDescriptor.create>[0];
    const instance = idbRuntimeAdapterDescriptor.create(fakeStack);
    expect(instance.familyId).toBe("idb");
    expect(instance.targetId).toBe("idb");
  });

  it("returned instance lower() resolves to the plan body", async () => {
    const fakeStack = {} as Parameters<typeof idbRuntimeAdapterDescriptor.create>[0];
    const instance = idbRuntimeAdapterDescriptor.create(fakeStack);
    const idbPlan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u1" };
    const plan = makePlan(idbPlan);
    const result = await instance.lower(plan, TEST_CTX);
    expect(result).toBe(idbPlan);
  });
});

describe("IdbAdapter.lower() — closure identities", () => {
  it("snapshots structured filter values without mutating the driver plan", async () => {
    const where = { kind: "field" as const, field: "score", op: "eq" as const, value: 10 };
    const idbPlan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      filter: () => true,
    };
    const result = await adapter.lower(
      { ...makePlan(idbPlan), ast: { kind: "findMany", modelName: "User", where } },
      TEST_CTX
    );
    const identity = canonicalStringify(where);
    where.value = 20;
    expect(result.queryIdentity?.filter).toBe(identity);
    expect(result).not.toBe(idbPlan);
    expect(result).toMatchObject(idbPlan);
    expect(idbPlan).not.toHaveProperty("queryIdentity");
  });

  it("preserves comparator field priority and directions", async () => {
    const orderBy = { score: "asc", id: "desc" } as const;
    const result = await adapter.lower(
      {
        ...makePlan({ meta: META, kind: "cursor-scan", storeName: "users" }),
        ast: { kind: "findMany", modelName: "User", orderBy },
      },
      TEST_CTX
    );
    expect(result.queryIdentity?.comparator).toBe(
      canonicalStringify([
        ["score", "asc"],
        ["id", "desc"],
      ])
    );
  });

  it("leaves unsupported filter values opaque without failing lowering", async () => {
    const idbPlan: IdbCursorScanPlan = { meta: META, kind: "cursor-scan", storeName: "users", filter: () => true };
    const result = await adapter.lower(
      {
        ...makePlan(idbPlan),
        ast: {
          kind: "findMany",
          modelName: "User",
          where: { kind: "field", field: "bytes", op: "eq", value: new ArrayBuffer(2) },
        },
      },
      TEST_CTX
    );
    expect(result).toBe(idbPlan);
    expect(result.queryIdentity).toBeUndefined();
  });
});
