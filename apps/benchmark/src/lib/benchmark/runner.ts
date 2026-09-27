import { runBenchmarkSuite as runKitSuite } from "@prisma-idb/benchmark-kit";
import { operationDefinitions } from "./operations";
import type { BenchmarkConfig, BenchmarkProgress, BenchmarkRunResult } from "./types";

export async function runBenchmarkSuite(
  config: BenchmarkConfig,
  onProgress?: (progress: BenchmarkProgress) => void,
  signal?: AbortSignal
): Promise<BenchmarkRunResult> {
  if (signal?.aborted) throw new DOMException("Benchmark run cancelled", "AbortError");
  const { PrismaIDBClient } = await import("../prisma-idb/client/prisma-idb-client");
  const client = await PrismaIDBClient.createClient();
  return runKitSuite({
    client,
    definitions: operationDefinitions,
    config,
    ...(onProgress !== undefined ? { onProgress } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}
