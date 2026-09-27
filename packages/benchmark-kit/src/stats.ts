import type { BenchmarkStatSummary } from "./types";

function round(value: number): number {
  return Number(value.toFixed(3));
}

function quantile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;

  const position = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex] ?? 0;
  }

  const lowerValue = sortedValues[lowerIndex] ?? 0;
  const upperValue = sortedValues[upperIndex] ?? lowerValue;

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}

export function summarizeSamples(samplesMs: number[]): BenchmarkStatSummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  const variance =
    sorted.reduce((sum, value) => {
      const delta = value - meanMs;
      return sum + delta * delta;
    }, 0) / Math.max(1, sorted.length);
  const stdDevMs = Math.sqrt(variance);
  const medianMs = quantile(sorted, 0.5);
  const p95Ms = quantile(sorted, 0.95);
  const p99Ms = quantile(sorted, 0.99);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;

  return {
    minMs: round(minMs),
    maxMs: round(maxMs),
    meanMs: round(meanMs),
    medianMs: round(medianMs),
    p95Ms: round(p95Ms),
    p99Ms: round(p99Ms),
    stdDevMs: round(stdDevMs),
    opsPerSecond: round(meanMs === 0 ? 0 : 1000 / meanMs),
  };
}
