"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GeistMono } from "geist/font/mono";
import { ChevronRight, Loader2, AlertCircle } from "lucide-react";
import { Section, SectionHeader } from "./section";

const PUBLIC_BENCHMARK_SNAPSHOT_URL =
  "https://cdn.jsdelivr.net/gh/prisma-idb/prisma-idb@benchmark-data/prisma-orm/latest.json";
const BENCHMARK_SOURCE_URL = "https://github.com/prisma-idb/prisma-idb/tree/main/apps/prisma-orm-benchmark";
const LEGACY_BENCHMARK_URL = "https://benchmark.prisma-idb.dev";

/**
 * The snapshot measures every query shape the planner handles, which is too many for the landing page.
 * These are shown, keyed by operation id, with labels written for readers who haven't seen the benchmark.
 */
const HEADLINE_OPERATIONS = [
  { id: "find-unique", label: "findUnique by primary key" },
  { id: "find-compound-exact", label: "Match on a compound index" },
  { id: "create-with-fk-check", label: "create, with foreign key validation" },
  { id: "delete-cascade-via-indexed-fk", label: "delete, cascading to children" },
];
const LIST_OPERATIONS = [
  { id: "include-books-by-author", label: "include a 1:N relation" },
  { id: "find-range-indexed", label: "Range on an indexed field" },
  { id: "find-order-by-indexed-take", label: "orderBy an indexed field, take 10" },
  { id: "find-eq-indexed", label: "Equality on an indexed field" },
  { id: "count-eq-indexed", label: "count, equality on an indexed field" },
  { id: "update-all-eq-indexed", label: "updateAll, equality on an indexed field" },
];
/** The same kind of query without an index, shown for contrast. */
const FULL_SCAN_OPERATION_ID = "find-eq-unindexed";

/** The list bars use a log scale between these bounds, so sub-millisecond and 100 ms results both stay readable. */
const BAR_MIN_MS = 0.1;
const BAR_MAX_MS = 200;

const SNAPSHOT_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

interface BenchmarkOperation {
  operationId: string;
  label: string;
  summary: { p95Ms: number; opsPerSecond: number };
}

interface BenchmarkSnapshot {
  completedAt: string;
  browser?: string;
  config: { datasetSize: number; warmupRuns: number; measuredRuns: number };
  operations: BenchmarkOperation[];
}

type SnapshotState =
  { status: "loading" } | { status: "ready"; snapshot: BenchmarkSnapshot } | { status: "unavailable" };

interface ShownOperation {
  id: string;
  label: string;
  /** p95 of one query. Operations that time a batch of N queries ("(×N)" in the label) are divided by N. */
  perQueryMs: number;
}

/** Batched operations are labelled "(×N)": each timed sample runs N queries. */
function batchSize(label: string): number {
  const match = /\(×(\d+)\)$/.exec(label);
  return match ? Number(match[1]) : 1;
}

function pick(operations: BenchmarkOperation[], wanted: readonly { id: string; label: string }[]): ShownOperation[] {
  return wanted.flatMap(({ id, label }) => {
    const op = operations.find((candidate) => candidate.operationId === id);
    return op ? [{ id, label, perQueryMs: op.summary.p95Ms / batchSize(op.label) }] : [];
  });
}

function splitMs(ms: number): { value: string; unit: string } {
  if (ms < 1) return { value: String(Math.round(ms * 1000)), unit: "µs" };
  if (ms < 10) return { value: ms.toFixed(1), unit: "ms" };
  return { value: String(Math.round(ms)), unit: "ms" };
}

function formatMs(ms: number): string {
  const { value, unit } = splitMs(ms);
  return `${value} ${unit}`;
}

function barWidth(ms: number): number {
  const position = (Math.log10(ms) - Math.log10(BAR_MIN_MS)) / (Math.log10(BAR_MAX_MS) - Math.log10(BAR_MIN_MS));
  return Math.max(2, Math.min(100, position * 100));
}

function chromeVersion(userAgent: string | undefined): string {
  const match = userAgent ? /Chrome\/(\d+)/.exec(userAgent) : null;
  return match ? `Chrome ${match[1]}` : "Chrome";
}

function isValidSnapshot(data: unknown): data is BenchmarkSnapshot {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Partial<BenchmarkSnapshot>;
  return (
    typeof candidate.completedAt === "string" &&
    typeof candidate.config === "object" &&
    candidate.config !== null &&
    typeof candidate.config.datasetSize === "number" &&
    typeof candidate.config.warmupRuns === "number" &&
    typeof candidate.config.measuredRuns === "number" &&
    Array.isArray(candidate.operations) &&
    candidate.operations.length > 0
  );
}

export function PerformanceSection() {
  const [state, setState] = useState<SnapshotState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function loadLatestSnapshot() {
      try {
        const response = await fetch(PUBLIC_BENCHMARK_SNAPSHOT_URL, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (controller.signal.aborted) return;
          setState({ status: "unavailable" });
          return;
        }
        const data: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!isValidSnapshot(data)) {
          setState({ status: "unavailable" });
          return;
        }
        setState({ status: "ready", snapshot: data });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: "unavailable" });
      }
    }

    void loadLatestSnapshot();
    return () => controller.abort();
  }, []);

  return (
    <Section>
      <SectionHeader eyebrow="Performance" title="Built for speed. Measured honestly.">
        Time per query at the 95th percentile, in real Chrome against real IndexedDB. Straight from the latest CI run on{" "}
        <code className="text-brand-text text-[0.9em]">main</code>.
      </SectionHeader>

      {state.status === "loading" ? (
        <PerformancePlaceholder
          icon={<Loader2 className="text-fd-muted-foreground h-5 w-5 animate-spin" />}
          title="Loading latest benchmark snapshot…"
          description="Fetching the most recent CI run from the public benchmark feed."
        />
      ) : state.status === "unavailable" ? (
        <PerformancePlaceholder
          icon={<AlertCircle className="h-5 w-5 text-amber-500 dark:text-amber-400" />}
          title="No benchmark snapshot is available yet."
          description="As soon as the benchmark workflow finishes a run on main, the latest results will appear here."
        />
      ) : (
        <PerformanceContent snapshot={state.snapshot} />
      )}
    </Section>
  );
}

function PerformancePlaceholder({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      role="status"
      className="border-fd-border flex flex-col items-center justify-center gap-2 border-y px-6 py-12 text-center"
    >
      {icon}
      <p className="text-fd-foreground text-sm font-medium">{title}</p>
      <p className="text-fd-muted-foreground max-w-md text-xs">{description}</p>
    </div>
  );
}

function PerformanceContent({ snapshot }: { snapshot: BenchmarkSnapshot }) {
  const { operations, config } = snapshot;
  const headlines = pick(operations, HEADLINE_OPERATIONS);
  const listed = pick(operations, LIST_OPERATIONS);
  const fullScan = pick(operations, [{ id: FULL_SCAN_OPERATION_ID, label: "" }])[0];
  // If the benchmark renames its operations, show its own labels rather than an empty section.
  const fallback =
    headlines.length === 0 && listed.length === 0
      ? operations.map((op) => ({
          id: op.operationId,
          label: op.label,
          perQueryMs: op.summary.p95Ms / batchSize(op.label),
        }))
      : [];
  const rows = [...listed, ...fallback];

  return (
    <>
      {headlines.length > 0 && (
        <dl className="border-fd-border grid grid-cols-2 border-y lg:grid-cols-4">
          {headlines.map((op, index) => {
            const { value, unit } = splitMs(op.perQueryMs);
            return (
              <div
                key={op.id}
                className={`border-fd-border flex flex-col-reverse justify-end px-4 py-6 sm:px-7 sm:py-8 ${
                  index % 2 === 1 ? "border-l" : ""
                } ${index >= 2 ? "border-t lg:border-t-0" : ""} ${index === 2 ? "lg:border-l" : ""}`}
              >
                <dt className="text-fd-muted-foreground mt-2.5 text-sm leading-snug">{op.label}</dt>
                <dd
                  className={`${GeistMono.className} text-brand-text text-3xl font-semibold tracking-tight tabular-nums sm:text-[44px]`}
                >
                  {value}
                  <span className="text-fd-muted-foreground ml-1 text-base font-medium sm:text-lg">{unit}</span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {rows.length > 0 && (
        <ul className="mt-8 grid grid-cols-1 gap-x-16 md:grid-cols-2">
          {rows.map((op) => (
            <li
              key={op.id}
              className="border-fd-border/70 grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-x-4 border-b py-3"
            >
              <span className="text-fd-foreground text-sm">{op.label}</span>
              <span className="h-0.75 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
                <span className="block h-full bg-[hsl(32,100%,50%)]" style={{ width: `${barWidth(op.perQueryMs)}%` }} />
              </span>
              <span
                className={`${GeistMono.className} text-fd-foreground text-right text-sm font-semibold tabular-nums`}
              >
                {formatMs(op.perQueryMs)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {fullScan && (
        <div className="mt-7 flex items-center justify-between gap-6 rounded-lg bg-zinc-200/60 px-5 py-4 dark:bg-zinc-900">
          <p className="text-fd-muted-foreground text-sm">
            For contrast, the same filter on an <span className="text-fd-foreground">unindexed</span> field scans the
            whole store.
          </p>
          <span className={`${GeistMono.className} text-fd-muted-foreground shrink-0 text-sm font-semibold`}>
            {formatMs(fullScan.perQueryMs)}
          </span>
        </div>
      )}

      <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-12">
        <p className="text-fd-muted-foreground max-w-xl text-xs leading-relaxed">
          {operations.length} operations measured, {config.measuredRuns} runs each after {config.warmupRuns} warmups,{" "}
          {config.datasetSize.toLocaleString("en-US")} rows per store · {chromeVersion(snapshot.browser)} ·{" "}
          {SNAPSHOT_DATE_FORMATTER.format(new Date(snapshot.completedAt))}. Batched operations are divided by their
          batch size. Writes include IndexedDB&apos;s transaction commit. Results vary by browser and device.
        </p>
        <div className="flex shrink-0 flex-col gap-2 text-sm sm:items-end">
          <Link
            href={BENCHMARK_SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-brand-text inline-flex items-center gap-1 font-medium hover:underline"
          >
            How it&apos;s measured
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href={LEGACY_BENCHMARK_URL}
            target="_blank"
            rel="noreferrer"
            className="text-fd-muted-foreground hover:text-fd-foreground inline-flex items-center gap-1"
          >
            Prisma 6 and 7: run the generator benchmark
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </>
  );
}
