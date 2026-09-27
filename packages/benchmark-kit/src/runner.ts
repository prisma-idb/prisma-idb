import { summarizeSamples } from "./stats";
import type { BenchmarkConfig, BenchmarkOperationResult, BenchmarkProgress, BenchmarkRunResult } from "./types";

/**
 * One benchmarked operation.
 *
 * `prepare` runs before every warmup and measured sample and is not timed.
 * Only `run` is timed. The context `prepare` returns is passed to `run`.
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
 * Runs every operation's warmup and measured samples in order, and returns
 * the per-operation samples and summaries. Runs in the browser: it reads
 * `navigator.userAgent` and `performance.now()`.
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

  const operations: BenchmarkOperationResult<OperationId>[] = [];

  for (const definition of definitions) {
    for (let warmup = 0; warmup < config.warmupRuns; warmup += 1) {
      throwIfAborted(signal);
      const context = await definition.prepare(client, config.datasetSize);
      throwIfAborted(signal);
      await definition.run(client, config.datasetSize, context);
      completedSteps += 1;
      onProgress?.({
        completedSteps,
        totalSteps,
        currentOperationLabel: definition.label,
        phase: "warmup",
      });
    }

    const samplesMs: number[] = [];

    for (let measureIndex = 0; measureIndex < config.measuredRuns; measureIndex += 1) {
      throwIfAborted(signal);
      const context = await definition.prepare(client, config.datasetSize);
      throwIfAborted(signal);
      const start = performance.now();
      await definition.run(client, config.datasetSize, context);
      const end = performance.now();
      samplesMs.push(end - start);
      throwIfAborted(signal);
      completedSteps += 1;
      onProgress?.({
        completedSteps,
        totalSteps,
        currentOperationLabel: definition.label,
        phase: "measure",
      });
    }

    operations.push({
      operationId: definition.operationId,
      label: definition.label,
      samplesMs,
      summary: summarizeSamples(samplesMs),
    });
  }

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
