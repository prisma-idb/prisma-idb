import type { ComparisonSummary } from "./compare";
import { BENCHMARK_REGRESSION_GATE } from "./types";

type ComparisonRow = ComparisonSummary["rows"][number];

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

function formatCIBound(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+∞" : "-∞";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function statusIcon(row: ComparisonRow, threshold: number): string {
  if (row.status === "FAIL") return row.noisy ? "🟠" : "🔴";
  if (row.status === "WARN") return "🟡";
  return isClearSpeedup(row, threshold) ? "🔵" : "🟢";
}

function renderRowsTable(rows: ComparisonRow[], threshold: number): string[] {
  const lines = ["| | Operation | Median Δ | 95% CI | Baseline → current (ms) |", "| :-: | :-- | ---: | :-- | :-- |"];
  for (const row of rows) {
    const medianDelta = row.bootstrap ? formatDeltaCompact(row.bootstrap.medianDeltaPercent) : "n/a";
    const ciRange = row.bootstrap
      ? `${formatCIBound(row.bootstrap.ciLowerPercent)} … ${formatCIBound(row.bootstrap.ciUpperPercent)}`
      : "n/a";
    lines.push(
      `| ${statusIcon(row, threshold)} | \`${row.operationId}\` | ${medianDelta} | ${ciRange} | ${formatMetric(row.median.baseline)} → ${formatMetric(row.median.current)} |`
    );
  }
  return lines;
}

/**
 * Renders one suite as a collapsible block, so several suites can share one PR
 * comment. The block starts open only when the gate failed, and lists the
 * flagged operations before the full table.
 */
export function renderMarkdown(summary: ComparisonSummary, threshold: number, title: string): string {
  const flagged = summary.rows.filter((r) => r.status !== "PASS");

  const gateLabel = summary.isAdvisory ? "ℹ️ advisory" : summary.shouldFail ? "❌ failed" : "✅ passed";
  const flaggedLabel = flagged.length > 0 ? ` · ${flagged.length} flagged` : "";

  const lines: string[] = [
    `<details${summary.shouldFail ? " open" : ""}>`,
    `<summary><b>${title}</b>: ${gateLabel} · ${summary.rows.length} operations${flaggedLabel}</summary>`,
    "",
  ];

  if (summary.notices.length > 0) {
    lines.push("> [!NOTE]");
    for (const notice of summary.notices) lines.push(`> ${notice}`);
    lines.push("> Merge is not blocked while advisory notices are present.");
    lines.push("");
  }

  if (flagged.length > 0) {
    lines.push(...renderRowsTable(flagged, threshold), "");
  }

  lines.push("<details><summary>All operations</summary>", "", ...renderRowsTable(summary.rows, threshold), "");
  lines.push("</details>", "");

  for (const [heading, ids] of [
    ["Added", summary.addedOperations],
    ["Removed (fails the gate)", summary.removedOperations],
  ] as const) {
    if (ids.length > 0) lines.push(`${heading}: ${ids.map((id) => `\`${id}\``).join(", ")}`, "");
  }

  lines.push(
    `<sub>Blocking regression: 95% bootstrap CI lower bound on the median change above +${threshold}% and a median change of at least ${BENCHMARK_REGRESSION_GATE.minAbsoluteDeltaMs}ms. 🔴 blocking · 🟠 high variance, non-blocking · 🟡 point estimate over the threshold, CI not · 🔵 clear speedup · 🟢 no clear change</sub>`,
    "",
    "</details>"
  );
  return `${lines.join("\n")}\n`;
}
