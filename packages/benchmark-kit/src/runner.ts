import { summarizeSamples } from "./stats";
import type { BenchmarkConfig, BenchmarkOperationResult, BenchmarkProgress, BenchmarkRunResult } from "./types";

/**
 * One benchmarked operation.
 *
 * `prepare` runs before every warmup and measured sample and is not timed.
 * Only `run` is timed. The context `prepare` returns is passed to `run`.
 * Samples of different operations are interleaved, so an operation must leave
 * the data as it found it.
 */
export interface BenchmarkOperationDefinition<Client, Context, OperationId extends string = string> {
  operationId: OperationId;
  label: string;
  prepare: (client: Client, datasetSize: number) => Promise<Context>;
  run: (client: Client, datasetSize: number, context: Context) => Promise<void>;
}

export interface RunBenchmarkSuiteOptions<Client, Context, OperationId extends string> {
  client: Client;
  definitions: ReadonlyArray<BenchmarkOperationDefinition<Client, Context, OperationId>>;
  config: BenchmarkConfig;
  onProgress?: (progress: BenchmarkProgress) => void;
  signal?: AbortSignal;
}

function nowIso() {
  return new Date().toISOString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Benchmark run cancelled", "AbortError");
}

/**
 * Runs the warmup and measured samples and returns the per-operation samples
 * and summaries. Runs in the browser: it reads `navigator.userAgent` and
 * `performance.now()`.
 *
 * Samples are taken round-robin, one per operation per round, rather than all
 * of one operation's samples back to back. A slow stretch on a shared CI
 * machine (a noisy neighbour, a GC pause) then spreads thinly over every
 * operation instead of shifting all samples of one, which the comparison
 * would read as a regression.
 */
export async function runBenchmarkSuite<Client, Context, OperationId extends string>(
  options: RunBenchmarkSuiteOptions<Client, Context, OperationId>
): Promise<BenchmarkRunResult<OperationId>> {
  const { client, definitions, config, onProgress, signal } = options;
  throwIfAborted(signal);
  const runStart = performance.now();
  const startedAt = nowIso();
  const totalSteps = definitions.length * (config.warmupRuns + config.measuredRuns);
  let completedSteps = 0;

  const samplesByOperation = definitions.map((): number[] => []);

  for (let round = 0; round < config.warmupRuns + config.measuredRuns; round += 1) {
    const phase = round < config.warmupRuns ? "warmup" : "measure";

    for (const [index, definition] of definitions.entries()) {
      throwIfAborted(signal);
      const context = await definition.prepare(client, config.datasetSize);
      throwIfAborted(signal);
      const start = performance.now();
      await definition.run(client, config.datasetSize, context);
      const end = performance.now();
      if (phase === "measure") samplesByOperation[index].push(end - start);
      throwIfAborted(signal);
      completedSteps += 1;
      onProgress?.({ completedSteps, totalSteps, currentOperationLabel: definition.label, phase });
    }
  }

  const operations: BenchmarkOperationResult<OperationId>[] = definitions.map((definition, index) => ({
    operationId: definition.operationId,
    label: definition.label,
    samplesMs: samplesByOperation[index],
    summary: summarizeSamples(samplesByOperation[index]),
  }));

  const runEnd = performance.now();
  const completedAt = nowIso();

  return {
    id: crypto.randomUUID(),
    startedAt,
    completedAt,
    browser: navigator.userAgent,
    config,
    totalDurationMs: Number((runEnd - runStart).toFixed(3)),
    operations,
  };
}
