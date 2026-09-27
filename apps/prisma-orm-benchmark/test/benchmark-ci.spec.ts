import { expect, test } from "@playwright/test";
import { readBenchmarkConfigFromEnv, writeBenchmarkResult } from "@prisma-idb/benchmark-kit/node";
import { BENCHMARK_DEFAULT_CONFIG } from "@prisma-idb/benchmark-kit";

test("runs benchmark suite and exports JSON result", async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);

  // 5000 rows so a full scan costs clearly more than the gate's 5ms floor.
  const { datasetSize, warmupRuns, measuredRuns } = readBenchmarkConfigFromEnv({
    ...BENCHMARK_DEFAULT_CONFIG,
    datasetSize: 5000,
  });

  // An uncaught error stops the suite without rendering either node below.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`/?autoStart&datasetSize=${datasetSize}&warmupRuns=${warmupRuns}&measuredRuns=${measuredRuns}`);

  const resultNode = page.getByTestId("benchmark-result");
  const errorNode = page.getByTestId("benchmark-error");
  await expect
    .poll(async () => pageErrors.length > 0 || (await resultNode.or(errorNode).count()) > 0, {
      timeout: 18 * 60 * 1000,
      intervals: [1000],
    })
    .toBe(true);
  if (pageErrors.length > 0) throw new Error(`Uncaught error in the page: ${pageErrors.join("; ")}`);
  if ((await errorNode.count()) > 0) {
    throw new Error(`Benchmark failed in the page: ${await errorNode.textContent()}`);
  }

  const resultText = await resultNode.textContent();
  if (!resultText) throw new Error("Benchmark result payload is empty");

  const parsedResult = JSON.parse(resultText) as {
    operations: Array<{ operationId: string; samplesMs: number[] }>;
  };
  expect(parsedResult.operations.length).toBeGreaterThan(0);
  for (const operation of parsedResult.operations) {
    expect(operation.samplesMs).toHaveLength(measuredRuns);
  }

  const resultPath = await writeBenchmarkResult({ ...parsedResult, platform: process.platform });
  test.info().annotations.push({ type: "benchmark-result", description: resultPath });
});
