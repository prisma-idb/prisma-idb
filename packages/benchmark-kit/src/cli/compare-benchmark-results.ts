import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BENCHMARK_REGRESSION_GATE } from "../types";
import { getStringArg, hasFlag, parseArgs } from "./cli-args";

interface BenchmarkOperation {
  operationId: string;
  samplesMs?: number[];
  summary?: { p95Ms?: number; meanMs?: number };
}

interface BenchmarkRun {
  id?: string;
  browser?: string;
  platform?: string;
  operations?: BenchmarkOperation[];
}

interface MetricPair {
  baseline: number | null;
  current: number | null;
  /** Percent change vs baseline; `Infinity` for baseline=0 → current>0; `null` if either side is missing. */
  delta: number | null;
}

interface BootstrapCI {
  /** Percent change in median, point estimate from observed samples. */
  medianDeltaPercent: number;
  /** 95% CI lower bound on the percent change in median. */
  ciLowerPercent: number;
  /** 95% CI upper bound on the percent change in median. */
  ciUpperPercent: number;
  /** Number of bootstrap resamples used. */
  iterations: number;
}

interface ComparisonRow {
  operationId: string;
  p95: MetricPair;
  mean: MetricPair;
  median: MetricPair;
  /** Bootstrap CI on the percent change in median. `null` when sample data is missing. */
  bootstrap: BootstrapCI | null;
  status: "PASS" | "WARN" | "FAIL";
  noisy?: boolean;
}

interface ComparisonSummary {
  thresholdPercent: number;
  comparedAt: string;
  baselineRunId: string | null;
  currentRunId: string | null;
  isAdvisory: boolean;
  notices: string[];
  rows: ComparisonRow[];
  regressions: ComparisonRow[];
  addedOperations: string[];
  removedOperations: string[];
  shouldFail: boolean;
}

const round = (value: number) => Number(value.toFixed(3));

/** Coefficient of variation threshold above which a measurement is flagged as noisy. */
const CV_THRESHOLD = 0.3;

/** Number of bootstrap resamples used to compute the CI on the median delta. */
const BOOTSTRAP_ITERATIONS = 2000;

/** Coefficient of variation (stdDev / mean). High CV → noisy measurement. */
function coefficientOfVariation(samples: number[] | undefined): number | null {
  if (!samples || samples.length < 2) return null;
  const n = samples.length;
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return null;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) / mean;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Bootstrap confidence interval on the percent change in median between two
 * sample sets. Resamples both arrays with replacement, computes the median
 * delta on each replicate, and returns the 2.5th / 97.5th percentiles as the
 * 95% CI bounds.
 *
 * Using the CI lower bound (instead of a point estimate) as the gate criterion
 * naturally handles benchmark noise: a true regression is one where even the
 * pessimistic edge of the CI exceeds the threshold.
 */
function bootstrapMedianDeltaCI(
  baselineSamples: number[] | undefined,
  currentSamples: number[] | undefined,
  iterations: number = BOOTSTRAP_ITERATIONS
): BootstrapCI | null {
  if (!baselineSamples || !currentSamples) return null;
  if (baselineSamples.length < 2 || currentSamples.length < 2) return null;

  const baselineMedian = medianOf(baselineSamples);
  const currentMedian = medianOf(currentSamples);
  if (!Number.isFinite(baselineMedian)) return null;

  // Zero-baseline ops (e.g. sub-millisecond ops measured as 0) are still
  // comparable: any non-zero current is an unbounded change. Downstream gating
  // requires |median delta| ≥ minAbsoluteDeltaMs, so micro-jitter still gets
  // filtered out and we don't flag noise.
  let observedDelta: number;
  if (baselineMedian === 0 && currentMedian === 0) {
    observedDelta = 0;
  } else if (baselineMedian === 0) {
    observedDelta = currentMedian > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  } else {
    observedDelta = ((currentMedian - baselineMedian) / baselineMedian) * 100;
  }

  const replicateDeltas: number[] = new Array(iterations);
  const baselineN = baselineSamples.length;
  const currentN = currentSamples.length;
  const baselineDraw = new Array<number>(baselineN);
  const currentDraw = new Array<number>(currentN);

  // Deterministic LCG seeded from a constant so identical inputs produce
  // identical CIs across runs (avoids gate flapping on borderline regressions).
  let rngState = 0x9e3779b9;
  const nextRandom = () => {
    rngState = (Math.imul(1664525, rngState) + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < baselineN; j++) {
      baselineDraw[j] = baselineSamples[Math.floor(nextRandom() * baselineN)];
    }
    for (let j = 0; j < currentN; j++) {
      currentDraw[j] = currentSamples[Math.floor(nextRandom() * currentN)];
    }
    const bMed = medianOf(baselineDraw);
    const cMed = medianOf(currentDraw);
    if (bMed === 0 && cMed === 0) {
      replicateDeltas[i] = 0;
    } else if (bMed === 0) {
      replicateDeltas[i] = cMed > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    } else {
      replicateDeltas[i] = ((cMed - bMed) / bMed) * 100;
    }
  }

  replicateDeltas.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lowerIdx = Math.floor(0.025 * iterations);
  const upperIdx = Math.min(iterations - 1, Math.floor(0.975 * iterations));

  return {
    medianDeltaPercent: round(observedDelta),
    ciLowerPercent: round(replicateDeltas[lowerIdx]),
    ciUpperPercent: round(replicateDeltas[upperIdx]),
    iterations,
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatDeltaCompact(value: number | null): string {
  if (value === null) return "n/a";
  if (!Number.isFinite(value)) return value > 0 ? "+∞" : "-∞";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function exceedsThresholdInDirection(
  value: number | null,
  threshold: number,
  direction: "positive" | "negative"
): boolean {
  if (value === null) return false;
  if (!Number.isFinite(value))
    return direction === "positive" ? value === Number.POSITIVE_INFINITY : value === Number.NEGATIVE_INFINITY;
  return direction === "positive" ? value > threshold : value < -threshold;
}

function getAbsoluteMedianDeltaMs(row: ComparisonRow): number | null {
  return row.median.baseline !== null && row.median.current !== null
    ? Math.abs(row.median.current - row.median.baseline)
    : null;
}

function isClearSpeedup(row: ComparisonRow, threshold: number): boolean {
  if (!row.bootstrap) return false;
  const absoluteMedianDelta = getAbsoluteMedianDeltaMs(row);
  const exceedsAbsolute =
    absoluteMedianDelta === null || absoluteMedianDelta >= BENCHMARK_REGRESSION_GATE.minAbsoluteDeltaMs;
  return exceedsAbsolute && exceedsThresholdInDirection(row.bootstrap.ciUpperPercent, threshold, "negative");
}

function describeTrend(row: ComparisonRow, threshold: number): string {
  if (!row.bootstrap) return "No sample data";
  if (row.status === "FAIL") return row.noisy ? "Noisy slowdown" : "Slowdown";
  if (row.status === "WARN") return "Possible slowdown";
  if (isClearSpeedup(row, threshold)) return "Speedup";
  if (exceedsThresholdInDirection(row.bootstrap.medianDeltaPercent, threshold, "negative")) return "Leaning faster";
  return "No clear change";
}

function formatCIBound(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+∞" : "-∞";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function pairMetric(baseline: number, current: number): MetricPair {
  const baselineOk = Number.isFinite(baseline);
  const currentOk = Number.isFinite(current);

  if (!baselineOk || !currentOk) {
    return {
      baseline: baselineOk ? round(baseline) : null,
      current: currentOk ? round(current) : null,
      delta: null,
    };
  }

  let delta: number;
  if (baseline === 0 && current === 0) delta = 0;
  else if (baseline === 0) delta = Number.POSITIVE_INFINITY;
  else delta = ((current - baseline) / baseline) * 100;

  return {
    baseline: round(baseline),
    current: round(current),
    delta: Number.isFinite(delta) ? round(delta) : delta,
  };
}

function renderMarkdown(summary: ComparisonSummary, threshold: number, title: string): string {
  const noisyRegressions = summary.rows.filter((r) => r.status === "FAIL" && r.noisy).length;
  const potentialRegressions = summary.rows.filter((r) => r.status === "WARN").length;
  const clearSpeedups = summary.rows.filter((r) => isClearSpeedup(r, threshold)).length;
  const leaningFaster = summary.rows.filter(
    (r) =>
      !isClearSpeedup(r, threshold) &&
      r.bootstrap &&
      exceedsThresholdInDirection(r.bootstrap.medianDeltaPercent, threshold, "negative")
  ).length;

  const gateLabel = summary.isAdvisory
    ? "ℹ️ advisory only (non-blocking)"
    : summary.shouldFail
      ? "❌ failed"
      : "✅ passed";

  const lines: string[] = [
    `## ${title}`,
    "",
    `| Summary | |`,
    `| :-- | :-- |`,
    `| **Gate metric** | bootstrap 95% CI on median delta |`,
    `| **Gate mode** | ${gateLabel} |`,
    `| **Regression threshold** | CI lower bound > +${threshold}% and ≥${BENCHMARK_REGRESSION_GATE.minAbsoluteDeltaMs}ms absolute median change |`,
    `| **Compared operations** | ${summary.rows.length} |`,
    `| **Blocking regressions** | ${summary.regressions.length} |`,
    `| **Potential regressions** | ${potentialRegressions} |`,
    `| **Noisy regressions (non-blocking)** | ${noisyRegressions} |`,
    `| **Clear speedups** | ${clearSpeedups} |`,
    `| **Leaning faster** | ${leaningFaster} |`,
    `| **Added / Removed** | ${summary.addedOperations.length} / ${summary.removedOperations.length} |`,
    "",
  ];

  if (summary.notices.length > 0) {
    lines.push("> [!NOTE]");
    for (const notice of summary.notices) lines.push(`> ${notice}`);
    lines.push("> Merge is not blocked while advisory notices are present.");
    lines.push("");
  }

  lines.push("> [!TIP]");
  lines.push(
    "> Gate status is based only on the median CI column below. p95/mean are context metrics and can disagree."
  );
  lines.push("");

  lines.push(
    "| Status | Operation | Trend | Gate decision | Median Δ | 95% CI | Baseline median | Current median |",
    "| :---: | :-- | :-- | :-- | ---: | :-- | ---: | ---: |"
  );

  for (const row of summary.rows) {
    const clearSpeedup = isClearSpeedup(row, threshold);
    const leaningSpeedup =
      !clearSpeedup &&
      row.bootstrap !== null &&
      exceedsThresholdInDirection(row.bootstrap.medianDeltaPercent, threshold, "negative");

    const statusIcon =
      row.status === "FAIL"
        ? row.noisy
          ? "\uD83D\uDFE0"
          : "\uD83D\uDD34"
        : row.status === "WARN"
          ? "\uD83D\uDFE1"
          : clearSpeedup
            ? "\uD83D\uDD35"
            : leaningSpeedup
              ? "\uD83D\uDFE9"
              : "\uD83D\uDFE2";
    const noisyTag = row.noisy ? " \uD83C\uDFB2" : "";
    const decision =
      row.status === "FAIL"
        ? row.noisy
          ? `CI lower > +${threshold}%, but high variance (non-blocking)`
          : `CI lower > +${threshold}%`
        : row.status === "WARN"
          ? `Point estimate > +${threshold}% but CI lower <= +${threshold}%`
          : clearSpeedup
            ? `CI upper < -${threshold}% (confident speedup)`
            : leaningSpeedup
              ? `Median indicates speedup, but CI still overlaps the neutral band`
              : `CI lower <= +${threshold}%`;
    const medianDelta = row.bootstrap ? formatDeltaCompact(row.bootstrap.medianDeltaPercent) : "n/a";
    const ciRange = row.bootstrap
      ? `${formatCIBound(row.bootstrap.ciLowerPercent)} … ${formatCIBound(row.bootstrap.ciUpperPercent)}`
      : "n/a";
    const trend = describeTrend(row, threshold);
    lines.push(
      `| ${statusIcon} | \`${row.operationId}\`${noisyTag} | ${trend} | ${decision} | ${medianDelta} | ${ciRange} | ${formatMetric(row.median.baseline)} | ${formatMetric(row.median.current)} |`
    );
  }

  lines.push("");
  lines.push("<details><summary>Context Metrics (Not Used For Gate)</summary>");
  lines.push("");
  lines.push("| Operation | Δ p95 | Δ mean |");
  lines.push("| :-- | ---: | ---: |");
  for (const row of summary.rows) {
    lines.push(
      `| \`${row.operationId}\` | ${formatDeltaCompact(row.p95.delta)} | ${formatDeltaCompact(row.mean.delta)} |`
    );
  }
  lines.push("", "</details>");

  for (const [heading, ids] of [
    ["Added Operations", summary.addedOperations],
    ["Removed Operations", summary.removedOperations],
  ] as const) {
    if (ids.length > 0) {
      lines.push("", `### ${heading}`, "");
      for (const id of ids) lines.push(`- \`${id}\``);
    }
  }

  const hasNoisyFail = summary.rows.some((r) => r.noisy && r.status === "FAIL");
  const hasHighCV = summary.rows.some((r) => r.noisy);

  lines.push("");
  lines.push("<details><summary>Legend</summary>", "");
  lines.push("| Symbol | Meaning |");
  lines.push("| :---: | :-- |");
  lines.push(`| 🟢 | Pass — CI lower <= +${threshold}% |`);
  lines.push(`| 🔵 | Clear speedup — CI upper < -${threshold}% |`);
  lines.push(`| 🟩 | Leaning faster — median shows speedup, but CI still overlaps neutral |`);
  lines.push("| 🟡 | Warn — point estimate exceeds threshold but CI lower bound does not (likely noise) |");
  lines.push(`| 🔴 | Fail — CI lower > +${threshold}% |`);
  if (hasNoisyFail) {
    lines.push("| 🟠 | Fail but noisy — high variance makes this unreliable |");
  }
  if (hasHighCV) {
    lines.push(
      `| 🎲 | High coefficient of variation (CV > ${(CV_THRESHOLD * 100).toFixed(0)}%) — samples are spread out |`
    );
  }
  lines.push(`| 📈 | Regression > ${threshold}% |`);
  lines.push(`| 📉 | Improvement > ${threshold}% |`);
  lines.push("", "</details>");

  lines.push("", `_Generated at ${new Date().toISOString()}_`);
  return `${lines.join("\n")}\n`;
}

async function loadJson(path: string): Promise<BenchmarkRun> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BenchmarkRun;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }
}

function getMeasuredSampleCount(run: BenchmarkRun): { count: number | null; hasPartialData: boolean } {
  const operations = run.operations ?? [];
  const counts = operations.flatMap((op) => (Array.isArray(op.samplesMs) ? [op.samplesMs.length] : []));
  const hasPartialData = counts.length < operations.length;
  if (counts.length === 0) return { count: null, hasPartialData };
  const allEqual = counts.every((c) => c === counts[0]);
  return { count: allEqual ? (counts[0] ?? null) : null, hasPartialData };
}

function getComparisonNotices(baseline: BenchmarkRun, current: BenchmarkRun): string[] {
  const notices: string[] = [];
  const minSamples = BENCHMARK_REGRESSION_GATE.minMeaningfulP95Samples;

  const runs = [
    ["Baseline", baseline],
    ["Current", current],
  ] as const;

  const counts: Record<"Baseline" | "Current", number | null> = { Baseline: null, Current: null };

  for (const [label, run] of runs) {
    const { count, hasPartialData } = getMeasuredSampleCount(run);
    counts[label] = count;
    if (hasPartialData) {
      notices.push(`${label} run is missing samplesMs for one or more operations; this comparison is advisory.`);
    }
    if (count === null) {
      notices.push(`${label} sample counts are missing or inconsistent across operations.`);
    } else if (count < minSamples) {
      notices.push(
        `${label} only has ${count} measured samples per operation; reliable median-delta bootstrap CI gating starts at ${minSamples}.`
      );
    }
  }

  if (counts.Baseline !== null && counts.Current !== null && counts.Baseline !== counts.Current) {
    notices.push(
      `Baseline and current runs use different measured sample counts (${counts.Baseline} vs ${counts.Current}); this comparison is advisory.`
    );
  }

  return notices;
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
      "Usage: compare-benchmark-results.ts --baseline <path> --current <path> [--threshold 10] [--title <text>] [--json-out <path>] [--markdown-out <path>] [--exit-on-fail]"
    );
  }

  const threshold = Number(getStringArg(args, "threshold") ?? String(BENCHMARK_REGRESSION_GATE.thresholdPercent));
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error("--threshold must be a positive number");
  }

  const [baseline, current] = await Promise.all([
    loadJson(resolve(process.cwd(), baselinePath)),
    loadJson(resolve(process.cwd(), currentPath)),
  ]);

  const baselineMap = new Map((baseline.operations ?? []).map((op) => [op.operationId, op]));
  const currentMap = new Map((current.operations ?? []).map((op) => [op.operationId, op]));

  const rows: ComparisonRow[] = [];
  const regressions: ComparisonRow[] = [];
  const addedOperations: string[] = [];
  const removedOperations: string[] = [];

  for (const operationId of new Set([...baselineMap.keys(), ...currentMap.keys()])) {
    const baselineOp = baselineMap.get(operationId);
    const currentOp = currentMap.get(operationId);

    if (!baselineOp && currentOp) {
      addedOperations.push(operationId);
      continue;
    }
    if (baselineOp && !currentOp) {
      removedOperations.push(operationId);
      continue;
    }
    if (!baselineOp || !currentOp) continue;

    const p95 = pairMetric(Number(baselineOp.summary?.p95Ms), Number(currentOp.summary?.p95Ms));
    const mean = pairMetric(Number(baselineOp.summary?.meanMs), Number(currentOp.summary?.meanMs));

    const baselineSamples = baselineOp.samplesMs;
    const currentSamples = currentOp.samplesMs;
    const median = pairMetric(
      baselineSamples ? medianOf(baselineSamples) : Number.NaN,
      currentSamples ? medianOf(currentSamples) : Number.NaN
    );
    const bootstrap = bootstrapMedianDeltaCI(baselineSamples, currentSamples);

    // Flag operations where either run has high coefficient of variation.
    // A high CV means the samples are spread out, making any % delta unreliable.
    const baselineCV = coefficientOfVariation(baselineSamples);
    const currentCV = coefficientOfVariation(currentSamples);
    const noisy =
      (baselineCV !== null && baselineCV > CV_THRESHOLD) || (currentCV !== null && currentCV > CV_THRESHOLD);

    // Gate criterion: lower bound of bootstrap CI on median delta must exceed the
    // threshold. This filters out apparent regressions caused by sample variance:
    // a true regression is one where even the pessimistic edge of the CI is above
    // the threshold. Also require the absolute median change to exceed
    // minAbsoluteDeltaMs to avoid flagging sub-millisecond jitter.
    const minAbsDelta = BENCHMARK_REGRESSION_GATE.minAbsoluteDeltaMs;
    const absoluteMedianDelta =
      median.baseline !== null && median.current !== null ? Math.abs(median.current - median.baseline) : null;
    const exceedsAbsolute = absoluteMedianDelta === null || absoluteMedianDelta >= minAbsDelta;
    const ciLower = bootstrap?.ciLowerPercent ?? null;
    // Only positive infinity counts as exceeding the threshold; -Infinity is a
    // huge improvement, not a regression.
    const ciExceedsThreshold = ciLower !== null && (ciLower === Number.POSITIVE_INFINITY || ciLower > threshold);
    const isRegression = ciExceedsThreshold && exceedsAbsolute;
    // Warn when the point estimate exceeds threshold but the CI lower bound
    // doesn't — i.e., the regression might be real but isn't statistically robust.
    const observedExceeds =
      bootstrap !== null &&
      (bootstrap.medianDeltaPercent === Number.POSITIVE_INFINITY || bootstrap.medianDeltaPercent > threshold);
    const isWarn = !isRegression && observedExceeds && exceedsAbsolute;

    const row: ComparisonRow = {
      operationId,
      p95,
      mean,
      median,
      bootstrap,
      status: isRegression ? "FAIL" : isWarn ? "WARN" : "PASS",
      noisy,
    };
    rows.push(row);
    if (isRegression && !noisy) regressions.push(row);
  }

  rows.sort((a, b) => a.operationId.localeCompare(b.operationId));
  regressions.sort((a, b) => a.operationId.localeCompare(b.operationId));
  addedOperations.sort();
  removedOperations.sort();

  const notices = getComparisonNotices(baseline, current);
  const isAdvisory = notices.length > 0;

  const summary: ComparisonSummary = {
    thresholdPercent: threshold,
    comparedAt: new Date().toISOString(),
    baselineRunId: baseline.id ?? null,
    currentRunId: current.id ?? null,
    isAdvisory,
    notices,
    rows,
    regressions,
    addedOperations,
    removedOperations,
    // Advisory comparisons (e.g. mismatched sample counts, missing samplesMs)
    // never block the gate — they're flagged as informational only.
    shouldFail: !isAdvisory && (regressions.length > 0 || removedOperations.length > 0),
  };

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
