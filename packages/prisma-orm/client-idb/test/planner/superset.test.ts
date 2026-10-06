import { expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  andExpr,
  evaluateFilter,
  fieldFilter as f,
  notExpr,
  nullCheckExpr,
  orExpr,
  type IdbFilterExpr,
  type IdbFilterOp,
} from "@prisma-idb/adapter-idb/runtime";
import { compareFieldValues } from "@prisma-idb/target-idb/runtime";
import { planQuery } from "../../src/core/planner/plan";
import { catalog, field, planContains, source } from "./fixtures";

const codecs = [
  "idb/string@1",
  "idb/int32@1",
  "idb/double@1",
  "idb/date@1",
  "idb/decimal@1",
  "idb/bytes@1",
  "idb/bool@1",
  "idb/bigint@1",
  "idb/json@1",
] as const;
const string = fc.oneof(fc.string({ maxLength: 5 }), fc.constantFrom("", "\uffff", "a\uffff", "\u0000"));
const integer = fc.integer({ min: -20, max: 20 });
const scalar = fc.oneof(
  fc.array(fc.oneof(string, integer), { maxLength: 3 }),
  fc.constant(NaN),
  fc.constant(new Date(NaN)),
  fc.constant(undefined),
  string,
  integer,
  integer.map((n) => new Date(n)),
  fc.array(integer, { maxLength: 3 }).map((values) => new Uint8Array(values)),
  fc.boolean(),
  fc.bigInt({ min: -20n, max: 20n }),
  fc.constant(null)
);
const metadata = fc.record({ codec: fc.constantFrom(...codecs), nullable: fc.boolean() });
function valueFor(codec: string): fc.Arbitrary<unknown> {
  switch (codec) {
    case "idb/string@1":
    case "idb/decimal@1":
      return string;
    case "idb/int32@1":
      return integer;
    case "idb/double@1":
      return fc.oneof(
        integer,
        integer.map((n) => n / 2),
        fc.constantFrom(-Infinity, Infinity, NaN)
      );
    case "idb/date@1":
      return fc.oneof(
        integer.map((n) => new Date(n)),
        fc.constant(new Date(NaN))
      );
    case "idb/bytes@1":
      return fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 3 }).map((values) => new Uint8Array(values));
    case "idb/bool@1":
      return fc.boolean();
    case "idb/bigint@1":
      return fc.bigInt({ min: -20n, max: 20n });
    default:
      return fc.oneof(scalar, fc.constant({ x: 1 }), fc.array(string, { maxLength: 2 }));
  }
}
const path = fc.uniqueArray(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 3 });
const inputs = fc
  .record({
    a: metadata,
    b: metadata,
    c: metadata,
    indexes: fc.array(fc.record({ path, array: fc.boolean(), unique: fc.boolean(), multiEntry: fc.boolean() }), {
      maxLength: 4,
    }),
    order: fc.option(fc.constantFrom("id", "a", "b", "c"), { nil: undefined }),
    descending: fc.boolean(),
    take: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
  })
  .chain((config) =>
    fc
      .record({
        id: string,
        a: config.a.nullable
          ? fc.oneof(valueFor(config.a.codec), fc.constant(null), fc.constant(undefined))
          : valueFor(config.a.codec),
        b: config.b.nullable
          ? fc.oneof(valueFor(config.b.codec), fc.constant(null), fc.constant(undefined))
          : valueFor(config.b.codec),
        c: config.c.nullable
          ? fc.oneof(valueFor(config.c.codec), fc.constant(null), fc.constant(undefined))
          : valueFor(config.c.codec),
      })
      .chain((row) => {
        const atom = fc
          .tuple(
            fc.constantFrom("id", "a", "b", "c"),
            fc.constantFrom<IdbFilterOp>(
              "eq",
              "in",
              "gt",
              "gte",
              "lt",
              "lte",
              "startsWith",
              "contains",
              "neq",
              "notIn"
            ),
            scalar,
            fc.boolean()
          )
          .map(([name, op, random, useRow]) => {
            const value = useRow ? row[name] : random;
            return f(name, op, op === "in" || op === "notIn" ? [value, random] : value);
          });
        const filter: fc.Arbitrary<IdbFilterExpr> = fc.oneof(
          atom,
          fc.array(atom, { maxLength: 5 }).map(andExpr),
          fc.array(atom, { maxLength: 3 }).map(orExpr),
          atom.map(notExpr),
          atom.map((expr) => andExpr([f("a", "eq", row.a), expr, nullCheckExpr("b", false)])),
          fc
            .tuple(fc.constantFrom("a", "b", "c"), scalar)
            .map(([name, random]) => orExpr([f(name, "eq", row[name]), f(name, "in", [random])]))
        );
        return filter.map((where) => ({ config, row, where }));
      })
  );

it("planned ranges contain every codec-supported row matched by evaluateFilter", () => {
  vi.stubGlobal("indexedDB", undefined);
  try {
    fc.assert(
      fc.property(inputs, ({ config, row, where }) => {
        const c = catalog(
          config.indexes.map((index, i) =>
            source(
              index.path.length === 1 && !index.array ? index.path[0]! : index.path,
              `index-${i}`,
              index.unique,
              index.multiEntry
            )
          ),
          {
            a: field(config.a.codec, config.a.nullable),
            b: field(config.b.codec, config.b.nullable),
            c: field(config.c.codec, config.c.nullable),
          }
        );
        const request = {
          where,
          ...(config.order === undefined
            ? {}
            : { orderBy: { [config.order]: config.descending ? ("desc" as const) : ("asc" as const) } }),
          ...(config.take === undefined ? {} : { take: config.take }),
        };
        const plan = planQuery(c, request);
        if (plan.access.kind === "ranges") {
          for (const range of plan.access.ranges) {
            if (range?.kind !== "bound") continue;
            const comparison = compareFieldValues(range.lower, range.upper);
            expect(comparison).toBeLessThanOrEqual(0);
            if (comparison === 0) expect(Boolean(range.lowerOpen || range.upperOpen)).toBe(false);
          }
        }
        if (evaluateFilter(where, row)) expect(planContains(plan, row)).toBe(true);
        if (plan.exact) expect(planContains(plan, row)).toBe(evaluateFilter(where, row));
      }),
      { numRuns: 5000, seed: 98003 }
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
