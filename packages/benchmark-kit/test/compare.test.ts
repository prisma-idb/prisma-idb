import { describe, expect, it } from "vitest";
import { compareRuns, mergeRuns, renderMarkdown, type BenchmarkRun } from "../src/compare";
import { BENCHMARK_REGRESSION_GATE } from "../src/types";

const THRESHOLD = BENCHMARK_REGRESSION_GATE.thresholdPercent;

/** Enough samples for the gate to be trusted (see `minMeaningfulP95Samples`). */
const SAMPLE_COUNT = BENCHMARK_REGRESSION_GATE.minMeaningfulP95Samples + 4;

/** Samples spread over `center ± 2`, so a run's median is `center` and its variance is small. */
function samplesAround(center: number, count = SAMPLE_COUNT): number[] {
  return Array.from({ length: count }, (_, i) => center + (i % 5) - 2);
}

function run(medians: Record<string, number>, sampleCount = SAMPLE_COUNT): BenchmarkRun {
  return {
    id: "run",
    operations: Object.entries(medians).map(([operationId, median]) => ({
      operationId,
      samplesMs: samplesAround(median, sampleCount),
    })),
  };
}

const rowStatus = (summary: ReturnType<typeof compareRuns>, operationId: string) =>
  summary.rows.find((row) => row.operationId === operationId)?.status;

describe("mergeRuns", () => {
  it("pools the samples of each operation and recomputes its summary", () => {
    const merged = mergeRuns([
      { id: "one", operations: [{ operationId: "op", samplesMs: [1, 2, 3] }] },
      { id: "two", operations: [{ operationId: "op", samplesMs: [10, 20, 30] }] },
    ]);

    expect(merged.id).toBe("one,two");
    expect(merged.operations).toHaveLength(1);
    expect(merged.operations?.[0]?.samplesMs).toEqual([1, 2, 3, 10, 20, 30]);
    expect(merged.operations?.[0]?.summary?.meanMs).toBe(11);
  });
});

describe("compareRuns", () => {
  it("fails the gate on a slowdown whose confidence interval clears the threshold", () => {
    const summary = compareRuns(run({ slow: 100, steady: 100 }), run({ slow: 150, steady: 100 }), THRESHOLD);

    expect(rowStatus(summary, "slow")).toBe("FAIL");
    expect(rowStatus(summary, "steady")).toBe("PASS");
    expect(summary.isAdvisory).toBe(false);
    expect(summary.shouldFail).toBe(true);
  });

  it("passes a slowdown under the absolute floor, however large in percent", () => {
    const floor = BENCHMARK_REGRESSION_GATE.minAbsoluteDeltaMs;
    const summary = compareRuns(run({ tiny: 1 }), run({ tiny: 1 + floor / 2 }), THRESHOLD);

    expect(rowStatus(summary, "tiny")).toBe("PASS");
    expect(summary.shouldFail).toBe(false);
  });

  it("passes a speedup", () => {
    const summary = compareRuns(run({ op: 150 }), run({ op: 100 }), THRESHOLD);

    expect(rowStatus(summary, "op")).toBe("PASS");
    expect(summary.shouldFail).toBe(false);
  });

  it("fails the gate when an operation disappears, and only notes an added one", () => {
    const summary = compareRuns(run({ kept: 100, removed: 100 }), run({ kept: 100, added: 100 }), THRESHOLD);

    expect(summary.removedOperations).toEqual(["removed"]);
    expect(summary.addedOperations).toEqual(["added"]);
    expect(summary.shouldFail).toBe(true);
  });

  it("is advisory, and never fails, when the runs have different sample counts", () => {
    const summary = compareRuns(run({ slow: 100 }), run({ slow: 150 }, SAMPLE_COUNT + 6), THRESHOLD);

    expect(rowStatus(summary, "slow")).toBe("FAIL");
    expect(summary.isAdvisory).toBe(true);
    expect(summary.notices.join(" ")).toContain("different measured sample counts");
    expect(summary.shouldFail).toBe(false);
  });

  it("is advisory when there are too few samples to trust the interval", () => {
    const tooFew = BENCHMARK_REGRESSION_GATE.minMeaningfulP95Samples - 1;
    const summary = compareRuns(run({ slow: 100 }, tooFew), run({ slow: 150 }, tooFew), THRESHOLD);

    expect(summary.isAdvisory).toBe(true);
    expect(summary.shouldFail).toBe(false);
  });
});

describe("renderMarkdown", () => {
  const failing = compareRuns(run({ slow: 100, steady: 100 }), run({ slow: 150, steady: 100 }), THRESHOLD);
  const passing = compareRuns(run({ steady: 100 }), run({ steady: 100 }), THRESHOLD);

  it("opens the suite block when the gate failed", () => {
    expect(renderMarkdown(failing, THRESHOLD, "suite")).toMatch(/^<details open>\n<summary><b>suite<\/b>: ❌ failed/);
  });

  it("closes the suite block when the gate passed or is advisory", () => {
    expect(renderMarkdown(passing, THRESHOLD, "suite")).toMatch(/^<details>\n<summary><b>suite<\/b>: ✅ passed/);

    const advisory = compareRuns(run({ slow: 100 }), run({ slow: 150 }, SAMPLE_COUNT + 6), THRESHOLD);
    expect(renderMarkdown(advisory, THRESHOLD, "suite")).toMatch(/^<details>\n<summary><b>suite<\/b>: ℹ️ advisory/);
  });

  it("lists flagged operations above a collapsed table of all of them", () => {
    const markdown = renderMarkdown(failing, THRESHOLD, "suite");
    const [flaggedPart, allPart] = markdown.split("<details><summary>All operations</summary>");

    expect(flaggedPart).toContain("`slow`");
    expect(flaggedPart).not.toContain("`steady`");
    expect(allPart).toContain("`slow`");
    expect(allPart).toContain("`steady`");
  });

  it("has no flagged table when nothing is flagged", () => {
    const markdown = renderMarkdown(passing, THRESHOLD, "suite");

    expect(markdown.split("<details><summary>All operations</summary>")[0]).not.toContain("`steady`");
  });
});
