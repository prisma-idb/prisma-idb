#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compareRuns, mergeRuns, renderMarkdown, type BenchmarkRun } from "../compare";
import { BENCHMARK_REGRESSION_GATE } from "../types";
import { getStringArg, hasFlag, parseArgs } from "./cli-args";

async function loadJson(path: string): Promise<BenchmarkRun> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BenchmarkRun;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }
}

/**
 * Loads the runs named by a comma-separated list of result files. Several
 * runs of one tree are merged so that a drift in machine speed between runs
 * is spread over both trees being compared.
 */
async function loadRuns(pathList: string): Promise<BenchmarkRun> {
  const runs = await Promise.all(pathList.split(",").map((path) => loadJson(resolve(process.cwd(), path))));
  return mergeRuns(runs);
}

async function writeOutput(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) return;
  const outputPath = resolve(process.cwd(), filePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const baselinePath = getStringArg(args, "baseline");
  const currentPath = getStringArg(args, "current");

  if (!baselinePath || !currentPath) {
    throw new Error(
      "Usage: compare-benchmark-results.ts --baseline <path[,path…]> --current <path[,path…]> [--threshold 10] [--title <text>] [--json-out <path>] [--markdown-out <path>] [--exit-on-fail]"
    );
  }

  const threshold = Number(getStringArg(args, "threshold") ?? String(BENCHMARK_REGRESSION_GATE.thresholdPercent));
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error("--threshold must be a positive number");
  }

  const [baseline, current] = await Promise.all([loadRuns(baselinePath), loadRuns(currentPath)]);

  const summary = compareRuns(baseline, current, threshold);

  const markdown = renderMarkdown(summary, threshold, getStringArg(args, "title") || "Benchmark Regression Report");

  // JSON.stringify serializes Infinity as `null` — matches our "no comparable delta" convention.
  await writeOutput(getStringArg(args, "json-out"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeOutput(getStringArg(args, "markdown-out"), markdown);

  process.stdout.write(markdown);

  if (hasFlag(args, "exit-on-fail") && summary.shouldFail) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
