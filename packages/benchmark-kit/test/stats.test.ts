import { describe, expect, it } from "vitest";
import { summarizeSamples } from "../src/stats";

describe("summarizeSamples", () => {
  it("sorts nonuniform samples numerically, interpolates tail percentiles and uses population deviation", () => {
    const samples = [20, 0, 10, 2];
    expect(summarizeSamples(samples)).toEqual({
      minMs: 0,
      maxMs: 20,
      meanMs: 8,
      medianMs: 6,
      p95Ms: 18.5,
      p99Ms: 19.7,
      stdDevMs: 7.874,
      opsPerSecond: 125,
    });
    expect(samples).toEqual([20, 0, 10, 2]);
  });

  it("reports finite zero statistics for no samples instead of NaN or infinite throughput", () => {
    expect(summarizeSamples([])).toEqual({
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      medianMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      stdDevMs: 0,
      opsPerSecond: 0,
    });
  });

  it("keeps a single sample's percentiles and rounds fractional throughput", () => {
    expect(summarizeSamples([3])).toEqual({
      minMs: 3,
      maxMs: 3,
      meanMs: 3,
      medianMs: 3,
      p95Ms: 3,
      p99Ms: 3,
      stdDevMs: 0,
      opsPerSecond: 333.333,
    });
  });
});
