import { describe, expect, it, vi } from "vitest";
import {
  andExpr,
  fieldFilter as f,
  notExpr,
  nullCheckExpr,
  orExpr,
  type IdbFilterExpr,
} from "@prisma-idb/adapter-idb/runtime";
import { explain } from "../../src/core/planner/explain";
import { planQuery } from "../../src/core/planner/plan";
import { catalog, field, planContains, source } from "./fixtures";

function descriptor(where?: IdbFilterExpr, indexes = [source("a", "by-a")]) {
  return JSON.parse(explain(planQuery(catalog(indexes), where === undefined ? {} : { where })));
}

describe("planQuery", () => {
  it("plans primary-key equality without IndexedDB", () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      expect(descriptor(f("id", "eq", "x"))).toEqual({
        access: "primary-key",
        keyPath: "id",
        ranges: [{ kind: "only", key: "x" }],
        exact: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("deduplicates and sorts point ranges", () => {
    expect(descriptor(f("a", "in", ["b", "a", "b"]))).toEqual({
      access: "index",
      index: "by-a",
      keyPath: "a",
      ranges: [
        { kind: "only", key: "a" },
        { kind: "only", key: "b" },
      ],
      exact: true,
    });
  });
  it("plans large membership lists without quadratic key comparisons", () => {
    const values = Array.from({ length: 6000 }, (_, i) => String((i * 7919) % 6000));
    const original = [...values];
    const cmp = indexedDB.cmp.bind(indexedDB);
    let comparisons = 0;
    vi.stubGlobal("indexedDB", {
      cmp(a: IDBValidKey, b: IDBValidKey) {
        comparisons++;
        return cmp(a, b);
      },
    });
    try {
      expect(descriptor(f("a", "in", values))).toEqual({ access: "full", exact: false });
      expect(values).toEqual(original);
      // Allow ample sorting overhead while catching an all-pairs deduplication pass.
      expect(comparisons).toBeLessThan(values.length * Math.ceil(Math.log2(values.length)) * 4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("deduplicates large membership lists before applying the range cap", () => {
    const values = Array.from({ length: 6000 }, (_, i) => ["c", "a", "b"][i % 3]!);
    expect(descriptor(f("a", "in", values))).toEqual({
      access: "index",
      index: "by-a",
      keyPath: "a",
      ranges: [
        { kind: "only", key: "a" },
        { kind: "only", key: "b" },
        { kind: "only", key: "c" },
      ],
      exact: true,
    });
  });
  it("normalizes same-field equality and membership OR", () => {
    expect(descriptor(orExpr([f("a", "eq", "b"), f("a", "in", ["a", "b"])]))).toEqual(
      descriptor(f("a", "in", ["a", "b"]))
    );
  });
  it("intersects repeated points and ranges", () => {
    expect(descriptor(andExpr([f("a", "in", ["a", "b", "c"]), f("a", "gte", "b"), f("a", "lte", "b")]))).toMatchObject({
      ranges: [{ kind: "only", key: "b" }],
      exact: true,
    });
  });
  it.each([
    f("a", "in", []),
    f("a", "in", "bad"),
    orExpr([]),
    andExpr([f("a", "eq", "a"), f("a", "eq", "b")]),
    andExpr([f("a", "gt", "b"), f("a", "lte", "b")]),
  ])("recognizes contradictions", (where) => {
    expect(descriptor(where)).toEqual({ access: "empty", exact: true });
  });
  it.each([
    orExpr([f("a", "eq", "x"), f("b", "eq", "x")]),
    notExpr(f("a", "eq", "x")),
    andExpr([f("a", "eq", "x"), notExpr(f("b", "eq", "x"))]),
    orExpr([andExpr([f("a", "eq", "x")]), f("a", "eq", "y")]),
  ])("falls back for excluded boolean shapes", (where) => {
    expect(descriptor(where)).toEqual({ access: "full", exact: false });
  });
  it("falls back for relation filters and multiple order fields", () => {
    const c = catalog([source("a", "by-a")]);
    expect(explain(planQuery(c, { where: f("a", "eq", "x"), hasRelationFilter: true }))).toBe(
      '{"access":"full","exact":false}'
    );
    expect(explain(planQuery(c, { where: f("a", "eq", "x"), orderBy: { a: "asc", b: "desc" }, take: 1 }))).toBe(
      '{"access":"full","exact":false}'
    );
  });
  it("ignores multiEntry sources", () => {
    expect(descriptor(f("a", "eq", "x"), [source("a", "tags", false, true)])).toEqual({ access: "full", exact: false });
  });
  it("keeps residual predicates out of exact plans", () => {
    expect(descriptor(andExpr([f("a", "eq", "x"), f("b", "contains", "y")]))).toMatchObject({
      access: "index",
      exact: false,
    });
    expect(descriptor(andExpr([f("a", "eq", "x"), nullCheckExpr("b", false)]))).toMatchObject({
      access: "index",
      exact: false,
    });
    expect(descriptor(andExpr([f("a", "eq", "x"), f("b", "eq", "y")]))).toMatchObject({
      access: "index",
      exact: false,
    });
  });
  it.each([null, undefined, true, 1n, {}, NaN, new Date(NaN), ["x", undefined]])(
    "rejects invalid equality keys: %s",
    (value) => {
      expect(descriptor(f("a", "eq", value))).toEqual({ access: "full", exact: false });
      expect(descriptor(f("a", "in", ["x", value]))).toEqual({ access: "full", exact: false });
    }
  );
  it.each(["idb/string@1", "idb/int32@1", "idb/double@1", "idb/date@1", "idb/decimal@1", "idb/bytes@1"])(
    "allows ranges for %s",
    (codecId) => {
      const values: Record<string, unknown[]> = {
        "idb/string@1": ["a", "z"],
        "idb/int32@1": [1, 9],
        "idb/double@1": [1.5, 9.5],
        "idb/date@1": [new Date(1), new Date(9)],
        "idb/decimal@1": ["1", "9"],
        "idb/bytes@1": [new Uint8Array([1]), new Uint8Array([9])],
      };
      const [lower, upper] = values[codecId]!;
      const plan = planQuery(catalog([source("a", "by-a")], { a: field(codecId, true) }), {
        where: andExpr([f("a", "gte", lower), f("a", "lt", upper)]),
      });
      expect(plan.access.kind).toBe("ranges");
      expect(plan.exact).toBe(true);
      expect(planContains(plan, { a: lower })).toBe(true);
      expect(planContains(plan, { a: upper })).toBe(false);
    }
  );
  it.each(["idb/bigint@1", "idb/bool@1", "idb/json@1", "custom/key@1"])("excludes ranges on %s", (codecId) => {
    expect(
      planQuery(catalog([source("a", "by-a")], { a: field(codecId) }), { where: f("a", "gt", "x") }).access.kind
    ).toBe("full");
  });
  it("allows key-valued points on JSON, but keeps invalid-key membership as residual", () => {
    const c = catalog([source("a", "by-a")], { a: field("idb/json@1") });
    expect(planQuery(c, { where: f("a", "eq", ["x"]) }).exact).toBe(true);
    expect(planQuery(c, { where: andExpr([f("a", "eq", "x"), f("a", "in", ["x", null])]) }).exact).toBe(false);
  });
  it("builds string prefixes without truncating Unicode suffixes", () => {
    for (const prefix of ["a", "a\uffff", "\uffff", ""]) {
      const plan = planQuery(catalog([source("a", "by-a")]), { where: f("a", "startsWith", prefix) });
      expect(planContains(plan, { a: prefix + "\uffff\uffff" })).toBe(true);
      expect(plan.exact).toBe(true);
      if (prefix) expect(planContains(plan, { a: "" })).toBe(false);
    }
  });
  it("does not use startsWith on non-string codecs or coercible query values", () => {
    expect(planQuery(catalog([source("n", "by-n")]), { where: f("n", "startsWith", "1") }).access.kind).toBe("full");
    expect(descriptor(f("a", "startsWith", 1)).access).toBe("full");
  });

  it("expands a compound full key and a compound prefix", () => {
    const indexes = [source(["a", "b"], "ab")];
    expect(descriptor(andExpr([f("a", "in", ["x", "y"]), f("b", "eq", "z")]), indexes)).toMatchObject({
      ranges: [
        { kind: "only", key: ["x", "z"] },
        { kind: "only", key: ["y", "z"] },
      ],
      exact: true,
    });
    expect(descriptor(f("a", "eq", "x"), indexes)).toMatchObject({
      ranges: [{ kind: "bound", lower: ["x"], upper: ["x", []], lowerOpen: false, upperOpen: true }],
      exact: true,
    });
  });
  it("preserves array keyPaths with one member", () => {
    expect(descriptor(f("a", "eq", "x"), [source(["a"], "array-a")])).toMatchObject({
      keyPath: ["a"],
      ranges: [{ kind: "only", key: ["x"] }],
    });
  });
  it.each([field("idb/string@1", true), field("idb/json@1"), field("idb/string@1", false, true)])(
    "rejects compound prefixes with incomplete trailing keys",
    (trailing) => {
      const c = catalog([source(["a", "b"], "ab")], { b: trailing });
      expect(planQuery(c, { where: f("a", "eq", "x") }).access.kind).toBe("full");
      expect(planQuery(c, { where: andExpr([f("a", "eq", "x"), f("b", "eq", "y")]) }).access.kind).toBe("ranges");
    }
  );
  it("uses the next compound member's range with correct suffix inclusion", () => {
    const c = catalog([source(["a", "b", "c"], "abc")]);
    for (const lowerOp of ["gt", "gte"] as const) {
      for (const upperOp of ["lt", "lte"] as const) {
        const plan = planQuery(c, { where: andExpr([f("a", "eq", "x"), f("b", lowerOp, "m"), f("b", upperOp, "s")]) });
        expect(planContains(plan, { a: "x", b: "m", c: "suffix" })).toBe(lowerOp === "gte");
        expect(planContains(plan, { a: "x", b: "p", c: "\uffff" })).toBe(true);
        expect(planContains(plan, { a: "x", b: "s", c: "" })).toBe(upperOp === "lte");
        expect(planContains(plan, { a: "y", b: "p", c: "" })).toBe(false);
        expect(plan.exact).toBe(true);
      }
    }
  });
  it("supports one-sided ranges on the first compound member", () => {
    const c = catalog([source(["a", "b"], "ab")]);
    const plan = planQuery(c, { where: f("a", "lte", "m") });
    expect(planContains(plan, { a: "m", b: "z" })).toBe(true);
    expect(planContains(plan, { a: "n", b: "z" })).toBe(false);
  });
  it("leaves predicates past the first range as residual", () => {
    expect(descriptor(andExpr([f("a", "gt", "m"), f("b", "eq", "z")]), [source(["a", "b"], "ab")])).toMatchObject({
      access: "index",
      exact: false,
    });
  });
  it("caps the compound membership product with a safe full scan", () => {
    const points = Array.from({ length: 33 }, (_, i) => String(i));
    expect(descriptor(andExpr([f("a", "in", points), f("b", "in", points)]), [source(["a", "b"], "ab")]).access).toBe(
      "full"
    );
  });

  it("ranks unique, primary, ordinary, and prefix point paths", () => {
    const c = catalog([source("a", "a"), source("b", "b-unique", true), source(["c", "a"], "ca")]);
    expect(
      JSON.parse(
        explain(
          planQuery(c, {
            where: andExpr([f("id", "eq", "id"), f("a", "eq", "a"), f("b", "eq", "b"), f("c", "eq", "c")]),
          })
        )
      ).index
    ).toBe("b-unique");
    expect(descriptor(andExpr([f("id", "eq", "x"), f("a", "eq", "y")])).access).toBe("primary-key");
    expect(
      descriptor(andExpr([f("a", "eq", "x"), f("b", "eq", "y")]), [source(["b", "c"], "bc"), source("a", "a")]).index
    ).toBe("a");
  });
  it("ranks prefixes before two-sided ranges and ranges before startsWith", () => {
    const indexes = [source("a", "a"), source(["b", "c"], "bc")];
    expect(descriptor(andExpr([f("a", "gte", "m"), f("a", "lte", "s"), f("b", "eq", "x")]), indexes).index).toBe("bc");
    expect(
      descriptor(andExpr([f("a", "startsWith", "x"), f("b", "gte", "m"), f("b", "lte", "s")]), [
        source("a", "a"),
        source("b", "b"),
      ]).index
    ).toBe("b");
  });
  it("breaks cost ties by fewer ranges, primary key, then declaration", () => {
    expect(
      descriptor(andExpr([f("a", "in", ["x", "y"]), f("b", "eq", "z")]), [source("a", "first"), source("b", "second")])
        .index
    ).toBe("second");
    expect(descriptor(andExpr([f("id", "gt", "x"), f("a", "gt", "x")])).access).toBe("primary-key");
    expect(
      descriptor(andExpr([f("a", "eq", "x"), f("b", "eq", "y")]), [source("b", "first"), source("a", "second")]).index
    ).toBe("first");
  });

  it("uses a complete ordering index with take in either direction", () => {
    const c = catalog([source("a", "a")]);
    for (const [order, direction] of [
      ["asc", "next"],
      ["desc", "prev"],
    ] as const) {
      expect(JSON.parse(explain(planQuery(c, { orderBy: { a: order }, take: 2 })))).toEqual({
        access: "index",
        index: "a",
        keyPath: "a",
        ranges: [{ kind: "all" }],
        direction,
        exact: true,
      });
      expect(planQuery(c, { orderBy: { id: order }, take: 2 }).direction).toBe(direction);
    }
  });
  it("retains a filtering source over a different ordering index", () => {
    const c = catalog([source("a", "a"), source("b", "b")]);
    const plan = planQuery(c, { where: f("a", "eq", "x"), orderBy: { b: "desc" }, take: 1 });
    expect(JSON.parse(explain(plan))).toMatchObject({ index: "a" });
    expect(plan.direction).toBeUndefined();
    expect(planQuery(c, { where: f("a", "gt", "x"), orderBy: { a: "desc" }, take: 1 }).direction).toBe("prev");
  });
  it("keeps ordering scan filters as residual", () => {
    const plan = planQuery(catalog([source("a", "a")]), {
      where: f("b", "contains", "x"),
      orderBy: { a: "asc" },
      take: 1,
    });
    expect(plan.direction).toBe("next");
    expect(plan.exact).toBe(false);
  });
  it("requires take and complete index coverage for ordering-only scans", () => {
    const c = catalog([source("a", "a")], { a: field("idb/string@1", true) });
    expect(planQuery(c, { orderBy: { a: "desc" }, take: 1 }).access.kind).toBe("full");
    expect(planQuery(catalog([source("a", "a")]), { orderBy: { a: "asc" } }).access.kind).toBe("full");
    expect(planQuery(c, { where: f("a", "eq", "x"), orderBy: { a: "desc" }, take: 1 }).direction).toBe("prev");
  });
});

it("does not emit reversed compound bounds for key literals outside the stored scalar type", () => {
  const plan = planQuery(catalog([source(["a", "b"], "ab")]), { where: f("a", "gt", ["array-key"]) });
  expect(explain(plan)).toBe('{"access":"full","exact":false}');
});
