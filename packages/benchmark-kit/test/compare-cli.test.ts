import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cli = fileURLToPath(new URL("../src/cli/compare-benchmark-results.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8" });
}

function writeRun(directory: string, id: string, value: number, count = 20): string {
  const path = join(directory, `${id}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id,
      operations: [{ operationId: "read", samplesMs: Array<number>(count).fill(value) }],
    })
  );
  return path;
}

test("CLI writes matching reports and returns a failing exit code for a blocking regression", () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-compare-"));
  try {
    const baseline = writeRun(directory, "baseline", 10);
    const current = writeRun(directory, "current", 20);
    const jsonPath = join(directory, "nested", "report.json");
    const markdownPath = join(directory, "report.md");
    const result = runCli([
      "--baseline",
      baseline,
      "--current",
      current,
      "--json-out",
      jsonPath,
      "--markdown-out",
      markdownPath,
      "--title=Test report",
      "--exit-on-fail",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(readFileSync(markdownPath, "utf8")).toBe(result.stdout);
    expect(result.stdout).toMatch(/^<details open>\n<summary><b>Test report<\/b>: ❌ failed/);
    expect(result.stdout).toContain("| 🔴 | `read` | +100.00% | +100.0% … +100.0% | 10 → 20 |");
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toMatchObject({
      baselineRunId: "baseline",
      currentRunId: "current",
      shouldFail: true,
      isAdvisory: false,
      rows: [
        {
          operationId: "read",
          status: "FAIL",
          noisy: false,
          median: { baseline: 10, current: 20, delta: 100 },
          bootstrap: { medianDeltaPercent: 100, ciLowerPercent: 100, ciUpperPercent: 100, iterations: 2000 },
        },
      ],
    });
    expect(runCli(["--baseline", baseline, "--current", current]).status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI pools comma-separated runs before applying the sample-count gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-compare-"));
  try {
    const baseline = [writeRun(directory, "baseline-1", 10, 10), writeRun(directory, "baseline-2", 10, 10)];
    const current = [writeRun(directory, "current-1", 20, 10), writeRun(directory, "current-2", 20, 10)];
    const result = runCli(["--baseline", baseline.join(","), "--current", current.join(","), "--exit-on-fail"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("❌ failed");
    expect(result.stdout).not.toContain("advisory");
    const customThreshold = runCli([
      "--baseline",
      baseline.join(","),
      "--current",
      current.join(","),
      "--threshold=100",
      "--exit-on-fail",
    ]);
    expect(customThreshold.status).toBe(0);
    expect(customThreshold.stdout).toContain("✅ passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reports usage, invalid thresholds, and unreadable input through stderr", () => {
  const missing = runCli([]);
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toMatch(/^Usage: compare-benchmark-results.ts/);
  const threshold = runCli(["--baseline=a", "--current=b", "--threshold=0"]);
  expect(threshold.status).toBe(1);
  expect(threshold.stderr).toBe("--threshold must be a positive number\n");
  const directory = mkdtempSync(join(tmpdir(), "benchmark-compare-"));
  try {
    const path = join(directory, "missing.json");
    const unreadable = runCli(["--baseline", path, "--current", path]);
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain(`Failed to parse ${path}:`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
