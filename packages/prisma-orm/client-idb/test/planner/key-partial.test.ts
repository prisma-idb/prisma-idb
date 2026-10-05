import { describe, expect, it } from "vitest";
import { andExpr, evaluateFilter, fieldFilter as f, type IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import { explain } from "../../src/core/planner/explain";
import { planQuery, type PlanRequest } from "../../src/core/planner/plan";
import { catalog, field, planContains, source } from "./fixtures";

const cases = [
  { codec: "idb/double@1", invalid: NaN, lower: 0, middle: 1, upper: 5 },
  { codec: "idb/date@1", invalid: new Date(NaN), lower: new Date(0), middle: new Date(1), upper: new Date(5) },
];

for (const { codec, invalid, lower, middle, upper } of cases) {
  describe(`key-partial codec ${codec}`, () => {
    const c = catalog([source("a", "a")], { a: field(codec) });
    const rows = [
      { id: "invalid", a: invalid, b: "group" },
      { id: "lower", a: lower, b: "group" },
      { id: "middle", a: middle, b: "group" },
      { id: "upper", a: upper, b: "other" },
    ];
    function compareWithFullScan(where: IdbFilterExpr, request: Omit<PlanRequest, "where"> = {}, queryCatalog = c) {
      const plan = planQuery(queryCatalog, { where, ...request });
      const matches = rows.filter((row) => evaluateFilter(where, row));
      const planned = rows.filter((row) => planContains(plan, row) && evaluateFilter(where, row));
      expect(planned).toEqual(matches);
      return JSON.parse(explain(plan));
    }
    it("falls back for inclusive-only comparisons that match non-keys", () => {
      const where = f("a", "gte", lower);
      expect(evaluateFilter(where, rows[0]!)).toBe(true);
      expect(compareWithFullScan(where)).toEqual({ access: "full", exact: false });
      expect(compareWithFullScan(f("a", "lte", upper))).toEqual({ access: "full", exact: false });
    });
    it("does not infer empty from contradictory closed bounds", () => {
      const where = andExpr([f("a", "gte", upper), f("a", "lte", lower)]);
      expect(evaluateFilter(where, rows[0]!)).toBe(true);
      expect(compareWithFullScan(where)).toEqual({ access: "full", exact: false });
    });
    it("still accelerates strict comparisons and mixed bounds", () => {
      const where = andExpr([f("a", "gt", lower), f("a", "lte", upper)]);
      expect(evaluateFilter(where, rows[0]!)).toBe(false);
      expect(compareWithFullScan(where)).toMatchObject({ access: "index", index: "a", exact: true });
      expect(compareWithFullScan(f("a", "lt", upper))).toMatchObject({ access: "index", exact: true });
      expect(compareWithFullScan(andExpr([f("a", "gt", upper), f("a", "lt", lower)]))).toEqual({
        access: "empty",
        exact: true,
      });
    });
    it("still accelerates valid-key points, whose evaluator excludes invalid dates and NaN", () => {
      expect(evaluateFilter(f("a", "eq", lower), rows[0]!)).toBe(false);
      expect(evaluateFilter(f("a", "in", [lower, upper]), rows[0]!)).toBe(false);
      expect(compareWithFullScan(f("a", "eq", lower))).toMatchObject({ access: "index", exact: true });
      expect(compareWithFullScan(andExpr([f("a", "eq", middle), f("a", "gte", lower)]))).toMatchObject({
        access: "index",
        exact: true,
      });
    });
    it("falls back for an unconstrained key-partial compound member", () => {
      const compound = catalog([source(["b", "a"], "ba")], { a: field(codec) });
      expect(compareWithFullScan(f("b", "eq", "group"), {}, compound)).toEqual({ access: "full", exact: false });
      const rejecting = andExpr([f("b", "eq", "group"), f("a", "gt", lower)]);
      expect(compareWithFullScan(rejecting, {}, compound)).toMatchObject({ access: "index", index: "ba", exact: true });
      expect(compareWithFullScan(andExpr([f("b", "eq", "group"), f("a", "gte", lower)]), {}, compound)).toEqual({
        access: "full",
        exact: false,
      });
    });
    it("allows a trailing key-partial member only when its residual predicate rejects non-keys", () => {
      const compound = catalog([source(["b", "c", "a"], "bca")], { a: field(codec) });
      const where = andExpr([f("b", "eq", "group"), f("a", "gt", lower)]);
      const plan = planQuery(compound, { where });
      const row = { id: "invalid", a: invalid, b: "group", c: "suffix" };
      expect(evaluateFilter(where, row)).toBe(false);
      expect(JSON.parse(explain(plan))).toMatchObject({ access: "index", index: "bca", exact: false });
      expect(planContains(plan, { ...row, a: middle })).toBe(true);
    });
    it("uses another safe filtering path when closed ranges cannot cover all rows", () => {
      const other = catalog([source("a", "a"), source("b", "b")], { a: field(codec) });
      expect(compareWithFullScan(andExpr([f("b", "eq", "group"), f("a", "gte", lower)]), {}, other)).toMatchObject({
        access: "index",
        index: "b",
        exact: false,
      });
    });
    it("falls back for ordering-only secondary and primary-key scans", () => {
      expect(compareWithFullScan(andExpr([]), { orderBy: { a: "asc" }, take: 1 })).toEqual({
        access: "full",
        exact: false,
      });
      const primary = { ...c, primaryKey: source("a", undefined, true), indexes: [] };
      expect(JSON.parse(explain(planQuery(primary, { orderBy: { a: "desc" }, take: 1 })))).toEqual({
        access: "full",
        exact: false,
      });
      expect(compareWithFullScan(f("a", "gt", lower), { orderBy: { a: "desc" }, take: 1 })).toMatchObject({
        access: "index",
        direction: "prev",
        exact: true,
      });
    });
  });
}
