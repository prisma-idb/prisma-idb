import { describe, expect, it } from "vitest";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import type { IdbQueryPlan, IdbLowererContext } from "../src/exports/runtime";
import descriptor from "../src/exports/runtime";
import type { IdbCursorScanPlan, IdbKeyGetPlan, IdbBatchPlan } from "@prisma-idb/driver-idb/runtime";
const META = { target: "idb", storageHash: "test-hash", lane: "test" } as const;
/** Wraps a driver plan in its public query envelope. */
function makePlan(idbPlan: IdbQueryPlan["idbPlan"]): IdbQueryPlan {
  return { meta: META, idbPlan };
}
const TEST_CTX: IdbLowererContext = { contract: { storage: { storageHash: "test-hash", stores: {} } } };
const adapter = descriptor.create({} as Parameters<typeof descriptor.create>[0]);

describe("adapter lowering", () => {
  it("lowers a descriptor-created adapter's key lookup without losing its key or metadata", async () => {
    const plan: IdbKeyGetPlan = { meta: META, kind: "key-get", storeName: "users", key: "u1" };
    expect(adapter.familyId).toBe("idb");
    expect(adapter.targetId).toBe("idb");
    expect(await adapter.lower(makePlan(plan), TEST_CTX)).toEqual(plan);
  });
  it("preserves batch operation order, records and patches", async () => {
    const plan: IdbBatchPlan = {
      meta: META,
      kind: "batch",
      storeNames: ["users", "posts"],
      ops: [
        { meta: META, kind: "put", storeName: "users", record: { id: "u1", name: "Alice" } },
        { meta: META, kind: "update", storeName: "users", key: "u1", patch: { name: "Bob" } },
        { meta: META, kind: "delete", storeName: "posts", key: "p1" },
      ],
    };
    expect(await adapter.lower(makePlan(plan), TEST_CTX)).toEqual(plan);
  });
  it("keeps cursor predicates executable with the same pagination", async () => {
    const plan: IdbCursorScanPlan = {
      meta: META,
      kind: "cursor-scan",
      storeName: "users",
      filter: (row) => row["active"] === true,
      skip: 1,
      take: 2,
    };
    const lowered = await adapter.lower(makePlan(plan), TEST_CTX);
    expect(lowered).toMatchObject({ kind: "cursor-scan", storeName: "users", skip: 1, take: 2, meta: META });
    if (lowered.kind !== "cursor-scan") throw new Error("Expected a cursor plan");
    expect([{ active: true }, { active: false }].filter((row) => lowered.filter!(row))).toEqual([{ active: true }]);
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
    expect(result).toMatchObject({ kind: "cursor-scan", storeName: "users" });
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
    expect(result).toMatchObject({ kind: "cursor-scan", storeName: "users" });
    expect(result.queryIdentity).toBeUndefined();
  });
});
