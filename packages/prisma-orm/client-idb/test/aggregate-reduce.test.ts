/**
 * `computeAggregateSpec` over row sets too large to spread into a call.
 *
 * `min` and `max` once used `Math.min(...values)`, which throws a
 * `RangeError` once the array is larger than the engine's argument limit.
 */
import { describe, expect, it } from "vitest";
import { computeAggregateSpec } from "../src/core/aggregate-builder";

const ROW_COUNT = 300_000;

describe("computeAggregateSpec", () => {
  it("computes min, max, sum and avg over a very large row set", () => {
    const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({ n: i + 1 }));

    const result = computeAggregateSpec(
      {
        lowest: { kind: "aggregate", fn: "min", field: "n" },
        highest: { kind: "aggregate", fn: "max", field: "n" },
        total: { kind: "aggregate", fn: "sum", field: "n" },
        mean: { kind: "aggregate", fn: "avg", field: "n" },
      },
      rows
    );

    expect(result).toEqual({
      lowest: 1,
      highest: ROW_COUNT,
      total: (ROW_COUNT * (ROW_COUNT + 1)) / 2,
      mean: (ROW_COUNT + 1) / 2,
    });
  });

  it("ignores null values and returns null when no row has a value", () => {
    const rows = [{ n: null }, { n: 4 }, { n: -2 }, {}];

    expect(
      computeAggregateSpec(
        { lowest: { kind: "aggregate", fn: "min", field: "n" }, highest: { kind: "aggregate", fn: "max", field: "n" } },
        rows
      )
    ).toEqual({ lowest: -2, highest: 4 });
    expect(computeAggregateSpec({ lowest: { kind: "aggregate", fn: "min", field: "n" } }, [{ n: null }])).toEqual({
      lowest: null,
    });
  });
});
