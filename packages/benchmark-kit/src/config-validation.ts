import type { BenchmarkConfig } from "./types";

export const BENCHMARK_LIMITS = {
  minDatasetSize: 100,
  maxDatasetSize: 25000,
  minWarmupRuns: 0,
  maxWarmupRuns: 8,
  minMeasuredRuns: 1,
  maxMeasuredRuns: 30,
} as const;

export type SanitizedBenchmarkConfigResult =
  | {
      ok: true;
      config: BenchmarkConfig;
    }
  | {
      ok: false;
      error: string;
    };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sanitizeBenchmarkConfigInputs(input: {
  datasetSize: unknown;
  warmupRuns: unknown;
  measuredRuns: unknown;
}): SanitizedBenchmarkConfigResult {
  const datasetSizeRaw = parseFiniteNumber(input.datasetSize);
  const warmupRunsRaw = parseFiniteNumber(input.warmupRuns);
  const measuredRunsRaw = parseFiniteNumber(input.measuredRuns);

  if (datasetSizeRaw === null || warmupRunsRaw === null || measuredRunsRaw === null) {
    return {
      ok: false,
      error: "Run settings must be valid numbers.",
    };
  }

  const datasetSize = Math.trunc(datasetSizeRaw);
  if (datasetSize < BENCHMARK_LIMITS.minDatasetSize) {
    return {
      ok: false,
      error: `Please use dataset size >= ${BENCHMARK_LIMITS.minDatasetSize}.`,
    };
  }
  const datasetSizeClamped = clamp(datasetSize, BENCHMARK_LIMITS.minDatasetSize, BENCHMARK_LIMITS.maxDatasetSize);

  const warmupRuns = clamp(Math.trunc(warmupRunsRaw), BENCHMARK_LIMITS.minWarmupRuns, BENCHMARK_LIMITS.maxWarmupRuns);
  const measuredRuns = clamp(
    Math.trunc(measuredRunsRaw),
    BENCHMARK_LIMITS.minMeasuredRuns,
    BENCHMARK_LIMITS.maxMeasuredRuns
  );

  return {
    ok: true,
    config: {
      datasetSize: datasetSizeClamped,
      warmupRuns,
      measuredRuns,
    },
  };
}
