import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BENCHMARK_DEFAULT_CONFIG, type BenchmarkConfig } from "./types";

function parseEnvInteger(name: string, defaultValue: number, minValue: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minValue) {
    throw new Error(`Environment variable ${name} must be an integer >= ${minValue}, got: ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Reads the run config from `BENCHMARK_DATASET_SIZE`, `BENCHMARK_WARMUP_RUNS`
 * and `BENCHMARK_MEASURED_RUNS`. An unset variable falls back to `defaults`.
 */
export function readBenchmarkConfigFromEnv(defaults: BenchmarkConfig = BENCHMARK_DEFAULT_CONFIG): BenchmarkConfig {
  return {
    datasetSize: parseEnvInteger("BENCHMARK_DATASET_SIZE", defaults.datasetSize, 1),
    warmupRuns: parseEnvInteger("BENCHMARK_WARMUP_RUNS", defaults.warmupRuns, 0),
    measuredRuns: parseEnvInteger("BENCHMARK_MEASURED_RUNS", defaults.measuredRuns, 1),
  };
}

/**
 * Writes a run result as JSON to `BENCHMARK_RESULT_PATH`, or to
 * `./.benchmark-results/current.json` when it is unset. Returns the path.
 */
export async function writeBenchmarkResult(result: unknown): Promise<string> {
  const resultPath = resolve(
    process.cwd(),
    process.env["BENCHMARK_RESULT_PATH"] ?? "./.benchmark-results/current.json"
  );
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return resultPath;
}
