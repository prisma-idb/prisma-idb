import type {
  BenchmarkOperationResult as KitOperationResult,
  BenchmarkRunResult as KitRunResult,
} from "@prisma-idb/benchmark-kit";

export {
  BENCHMARK_DEFAULT_CONFIG,
  BENCHMARK_REGRESSION_GATE,
  type BenchmarkConfig,
  type BenchmarkProgress,
  type BenchmarkStatSummary,
} from "@prisma-idb/benchmark-kit";

export const BENCHMARK_OPERATION_IDS = [
  "create-user",
  "create-many-todos",
  "find-many-completed",
  "find-many-completed-sorted",
  "find-many-completed-paginated",
  "find-many-with-user-include",
  "update-many-completed",
  "delete-many-completed",
  "find-many-title-contains",
] as const;

export type BenchmarkOperationId = (typeof BENCHMARK_OPERATION_IDS)[number];

export const BENCHMARK_DATASET_SIZE_OPTIONS = [500, 1000, 5000, 10000, 25000] as const;

export type BenchmarkOperationResult = KitOperationResult<BenchmarkOperationId>;
export type BenchmarkRunResult = KitRunResult<BenchmarkOperationId>;
