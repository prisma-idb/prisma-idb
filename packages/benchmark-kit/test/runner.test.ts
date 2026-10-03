import { describe, expect, it } from "vitest";
import { runBenchmarkSuite, type BenchmarkOperationDefinition } from "../src/runner";
import type { BenchmarkProgress } from "../src/types";

/** Records every step in `events` so tests can assert the order the runner took them in. */
function recordingDefinition(operationId: string, events: string[]): BenchmarkOperationDefinition<null, string> {
  return {
    operationId,
    label: `label ${operationId}`,
    prepare: async () => {
      events.push(`prepare ${operationId}`);
      return `context ${operationId}`;
    },
    run: async (_client, _datasetSize, context) => {
      events.push(`run ${operationId} (${context})`);
    },
    cleanup: async (_client, _datasetSize, context) => {
      events.push(`cleanup ${operationId} (${context})`);
    },
  };
}

describe("runBenchmarkSuite", () => {
  const config = { datasetSize: 10, warmupRuns: 1, measuredRuns: 2 };

  it("takes one sample per operation per round, in definition order", async () => {
    const events: string[] = [];
    await runBenchmarkSuite({
      client: null,
      definitions: [recordingDefinition("a", events), recordingDefinition("b", events)],
      config,
    });

    const runs = events.filter((event) => event.startsWith("run ")).map((event) => event.split(" ")[1]);
    expect(runs).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  it("prepares before and cleans up after each run, passing the context along", async () => {
    const events: string[] = [];
    await runBenchmarkSuite({
      client: null,
      definitions: [recordingDefinition("a", events), recordingDefinition("b", events)],
      config: { ...config, warmupRuns: 0, measuredRuns: 1 },
    });

    expect(events).toEqual([
      "prepare a",
      "run a (context a)",
      "cleanup a (context a)",
      "prepare b",
      "run b (context b)",
      "cleanup b (context b)",
    ]);
  });

  it("keeps only the measured rounds as samples", async () => {
    const result = await runBenchmarkSuite({
      client: null,
      definitions: [recordingDefinition("a", []), recordingDefinition("b", [])],
      config,
    });

    expect(result.operations.map((operation) => [operation.operationId, operation.samplesMs.length])).toEqual([
      ["a", 2],
      ["b", 2],
    ]);
  });

  it("reports progress per step, warmup rounds first", async () => {
    const progress: BenchmarkProgress[] = [];
    await runBenchmarkSuite({
      client: null,
      definitions: [recordingDefinition("a", []), recordingDefinition("b", [])],
      config,
      onProgress: (step) => progress.push(step),
    });

    expect(progress.map((step) => [step.phase, step.completedSteps, step.currentOperationLabel])).toEqual([
      ["warmup", 1, "label a"],
      ["warmup", 2, "label b"],
      ["measure", 3, "label a"],
      ["measure", 4, "label b"],
      ["measure", 5, "label a"],
      ["measure", 6, "label b"],
    ]);
    expect(progress.every((step) => step.totalSteps === 6)).toBe(true);
  });
});
