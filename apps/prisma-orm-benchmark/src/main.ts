import { runBenchmarkSuite, sanitizeBenchmarkConfigInputs, type BenchmarkConfig } from "@prisma-idb/benchmark-kit";
import { createSeededDatabase, openClient } from "./database";
import { operationDefinitions } from "./operations";

/**
 * Minimal page for running the suite by hand or from CI.
 *
 * CI opens `/?autoStart&datasetSize=…&warmupRuns=…&measuredRuns=…`. The page
 * seeds the database, runs the suite and writes the result JSON into
 * `[data-testid=benchmark-result]`, or the error into
 * `[data-testid=benchmark-error]`.
 */

const form = document.querySelector<HTMLFormElement>("#config")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const output = document.querySelector<HTMLDivElement>("#output")!;

// A second run would block on deleting the database the first run still has
// open, and both would then write results into the page.
let running = false;

async function run(config: BenchmarkConfig): Promise<void> {
  output.replaceChildren();
  status.textContent = `Seeding ${config.datasetSize} rows per store…`;
  await createSeededDatabase(config.datasetSize);
  const client = openClient();
  try {
    const result = await runBenchmarkSuite({
      client,
      definitions: operationDefinitions,
      config,
      onProgress: (p) => {
        status.textContent = `${p.phase} ${p.completedSteps}/${p.totalSteps}: ${p.currentOperationLabel}`;
      },
    });
    status.textContent = `Done in ${(result.totalDurationMs / 1000).toFixed(1)}s`;

    const table = document.createElement("table");
    table.innerHTML = "<tr><th>Operation</th><th>Median ms</th><th>p95 ms</th><th>Mean ms</th></tr>";
    for (const op of result.operations) {
      const row = table.insertRow();
      for (const text of [op.label, op.summary.medianMs, op.summary.p95Ms, op.summary.meanMs]) {
        row.insertCell().textContent = String(text);
      }
    }
    const json = document.createElement("pre");
    json.dataset["testid"] = "benchmark-result";
    json.hidden = true;
    json.textContent = JSON.stringify(result);
    output.append(table, json);
  } finally {
    await client.close();
  }
}

function start(input: { datasetSize: unknown; warmupRuns: unknown; measuredRuns: unknown }): void {
  const sanitized = sanitizeBenchmarkConfigInputs(input);
  if (!sanitized.ok) {
    showError(sanitized.error);
    return;
  }
  if (running) return;
  running = true;
  run(sanitized.config)
    .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
    .finally(() => {
      running = false;
    });
}

function showError(message: string): void {
  status.textContent = "Failed";
  const node = document.createElement("pre");
  node.dataset["testid"] = "benchmark-error";
  node.textContent = message;
  output.replaceChildren(node);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  start({
    datasetSize: data.get("datasetSize"),
    warmupRuns: data.get("warmupRuns"),
    measuredRuns: data.get("measuredRuns"),
  });
});

const params = new URLSearchParams(location.search);
if (params.has("autoStart")) {
  start({
    datasetSize: params.get("datasetSize"),
    warmupRuns: params.get("warmupRuns"),
    measuredRuns: params.get("measuredRuns"),
  });
}
