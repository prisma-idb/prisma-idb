import { expect, it } from "vitest";
import { fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import { lowerWrite } from "../../src/core/planner/lower";
import { planQuery } from "../../src/core/planner/plan";
import { catalog, source } from "./fixtures";

const meta = { target: "idb", storageHash: "test", lane: "test", annotations: {} };

it("bounds a write by its index range and reapplies the full filter", () => {
  const c = catalog([source("a", "byA")]);
  const where = fieldFilter("a", "eq", "a1");
  const lowered = lowerWrite(c, planQuery(c, { where }), meta, { where, write: "put-merged", patch: { b: "new" } });
  expect(lowered.kind).toBe("scan");
  if (lowered.kind !== "scan") throw new Error("Expected a scan");
  expect(lowered.idbPlan).toMatchObject({ kind: "scan-write", indexName: "byA", range: { kind: "only", key: "a1" } });
  if (lowered.idbPlan.kind !== "scan-write") throw new Error("Expected scan-write");
  expect(lowered.idbPlan.filter!({ a: "a1" })).toBe(true);
  expect(lowered.idbPlan.filter!({ a: "a2" })).toBe(false);
});

it("collects all ranges before changing a walked field, including compound trailing fields", () => {
  const c = catalog([source(["a", "b"], "byAB")]);
  const where = fieldFilter("a", "in", ["a1", "a2"]);
  const logical = planQuery(c, { where });
  const lowered = lowerWrite(c, logical, meta, { where, write: "put-merged", patch: { b: "new" } });
  expect(lowered.kind).toBe("collect");
});

it("does not collect before deleting through an index", () => {
  const c = catalog([source("a", "byA")]);
  const where = fieldFilter("a", "in", ["a1", "a2"]);
  const lowered = lowerWrite(c, planQuery(c, { where }), meta, { where, write: "delete" });
  expect(lowered.kind).toBe("scan");
  if (lowered.kind !== "scan") throw new Error("Expected a scan");
  expect(lowered.idbPlan).toMatchObject({
    kind: "batch",
    ops: [
      { kind: "scan-write", indexName: "byA" },
      { kind: "scan-write", indexName: "byA" },
    ],
  });
});

it("collects before a primary-key patch or a limited multi-range write", () => {
  const c = catalog([source("a", "byA")]);
  expect(lowerWrite(c, planQuery(c, {}), meta, { write: "put-merged", patch: { id: "new" } }).kind).toBe("collect");
  const where = fieldFilter("a", "in", ["a1", "a2"]);
  expect(
    lowerWrite(c, planQuery(c, { where }), meta, { where, write: "put-merged", take: 1, patch: { b: "new" } }).kind
  ).toBe("collect");
});

it("emits no writes for an empty access", () => {
  const c = catalog();
  const where = fieldFilter("id", "in", []);
  const lowered = lowerWrite(c, planQuery(c, { where }), meta, { where, write: "delete" });
  expect(lowered).toMatchObject({ kind: "scan", idbPlan: { kind: "batch", ops: [] } });
});
