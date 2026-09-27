import { expect, test } from "@playwright/test";
import { readBenchmarkConfigFromEnv, writeBenchmarkResult } from "@prisma-idb/benchmark-kit/node";

test("runs benchmark suite and exports JSON result", async ({ page }) => {
  test.setTimeout(12 * 60 * 1000);

  const { datasetSize, warmupRuns, measuredRuns } = readBenchmarkConfigFromEnv();

  await page.goto(`/?autoStart&datasetSize=${datasetSize}&warmupRuns=${warmupRuns}&measuredRuns=${measuredRuns}`);

  const errorNode = page.getByTestId("benchmark-error");
  await expect(errorNode).toHaveCount(0);

  const resultNode = page.getByTestId("benchmark-result");
  await expect(resultNode).toBeAttached({ timeout: 10 * 60 * 1000 });

  const resultText = await resultNode.textContent();
  if (!resultText) {
    throw new Error("Benchmark result payload is empty");
  }

  const parsedResult = JSON.parse(resultText) as {
    operations: Array<{ operationId: string; summary: { p95Ms: number; meanMs: number } }>;
  };

  expect(Array.isArray(parsedResult.operations)).toBe(true);
  expect(parsedResult.operations.length).toBeGreaterThan(0);

  for (const operation of parsedResult.operations) {
    expect(operation.summary.p95Ms).toBeGreaterThanOrEqual(0);
    expect(operation.summary.meanMs).toBeGreaterThanOrEqual(0);
  }

  const resultPath = await writeBenchmarkResult({ ...parsedResult, platform: process.platform });

  test.info().annotations.push({ type: "benchmark-result", description: resultPath });
});
