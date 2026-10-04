import { summarizeSamples } from "./stats";
import { BENCHMARK_REGRESSION_GATE } from "./types";

export { renderMarkdown } from "./compare-report";

export interface BenchmarkOperation {
  operationId: string;
  samplesMs?: number[];
  summary?: { p95Ms?: number; meanMs?: number };
}

export interface BenchmarkRun {
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

export interface ComparisonSummary {
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

/** Merges runs of one tree into a single run, concatenating each operation's samples. */
export function mergeRuns(runs: BenchmarkRun[]): BenchmarkRun {
  const merged = new Map<string, BenchmarkOperation>();
  for (const operation of runs.flatMap((run) => run.operations ?? [])) {
    const previous = merged.get(operation.operationId);
    const samplesMs = previous
      ? previous.samplesMs && operation.samplesMs && [...previous.samplesMs, ...operation.samplesMs]
      : operation.samplesMs;
    merged.set(operation.operationId, {
      operationId: operation.operationId,
      samplesMs,
      summary: samplesMs ? summarizeSamples(samplesMs) : operation.summary,
    });
  }
  return { ...runs[0], id: runs.map((run) => run.id).join(","), operations: [...merged.values()] };
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

/**
 * Compares two runs operation by operation and applies the regression gate.
 * Each side may be several runs of one tree merged with `mergeRuns`.
 */
export function compareRuns(baseline: BenchmarkRun, current: BenchmarkRun, threshold: number): ComparisonSummary {
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

  return {
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
}
