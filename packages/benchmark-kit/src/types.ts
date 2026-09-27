export interface BenchmarkConfig {
  datasetSize: number;
  warmupRuns: number;
  measuredRuns: number;
}

export const BENCHMARK_DEFAULT_CONFIG: BenchmarkConfig = {
  datasetSize: 1000,
  warmupRuns: 2,
  measuredRuns: 30,
};

export const BENCHMARK_REGRESSION_GATE = {
  thresholdPercent: 10,
  minMeaningfulP95Samples: 20,
  minAbsoluteDeltaMs: 5,
} as const;

export interface BenchmarkStatSummary {
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  stdDevMs: number;
  opsPerSecond: number;
}

export interface BenchmarkOperationResult<OperationId extends string = string> {
  operationId: OperationId;
  label: string;
  samplesMs: number[];
  summary: BenchmarkStatSummary;
}

export interface BenchmarkRunResult<OperationId extends string = string> {
  id: string;
  startedAt: string;
  completedAt: string;
  browser: string;
  platform?: string;
  config: BenchmarkConfig;
  totalDurationMs: number;
  operations: BenchmarkOperationResult<OperationId>[];
}

export interface BenchmarkProgress {
  completedSteps: number;
  totalSteps: number;
  currentOperationLabel: string;
  phase: "warmup" | "measure";
}
