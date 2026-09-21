import type { ReactNode } from "react";
import Image from "next/image";
import { BookOpenText, Download, LoaderCircle, Moon, Sun, Trash2, X } from "lucide-react";
import { LatencyChart, ThroughputChart } from "@/components/charts/benchmark-bar-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BENCHMARK_DATASET_SIZE_OPTIONS, BENCHMARK_DEFAULT_CONFIG } from "@/lib/benchmark/types";
import { BENCHMARK_LIMITS } from "@/lib/benchmark/config-validation";
import type { BenchmarkDashboardController } from "./use-benchmark-dashboard-controller";
import Favicon from "@/assets/favicon.png";

type SectionProps = { controller: BenchmarkDashboardController };

function formatMs(value: number): string {
  if (value < 10) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  return `${Math.round(value)} ms`;
}

function formatOpsPerSecond(value: number): string {
  return `${Math.round(value)} ops/s`;
}

function userImpactLabel(p95Ms: number): string {
  if (p95Ms < 20) return "Feels instant";
  if (p95Ms < 60) return "Feels quick";
  if (p95Ms < 150) return "Slightly delayed";
  return "Noticeable delay";
}

function IconLink({
  href,
  label,
  title,
  children,
}: {
  href: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <a
      className="border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 items-center justify-center rounded-lg border transition-colors"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={title}
    >
      {children}
    </a>
  );
}

export function BenchmarkDashboardTopBar({ controller }: SectionProps) {
  const { themeMode, toggleTheme } = controller;
  return (
    <div className="border-border/80 bg-background/85 sticky top-0 z-50 border-b backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Image src={Favicon} alt="Prisma IDB" height={36} className="h-9 w-auto" priority />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Prisma IDB Benchmark Lab</p>
            <p className="text-muted-foreground truncate text-xs">
              Track how local-first data operations feel for real users.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <IconLink href="https://github.com/prisma-idb/prisma-idb" label="GitHub" title="GitHub">
            <svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="size-4 fill-current">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </IconLink>
          <IconLink href="https://www.npmjs.com/package/@prisma-idb/idb-client-generator" label="npm" title="npm">
            <svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="size-4 fill-current">
              <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
            </svg>
          </IconLink>
          <IconLink href="https://github.com/prisma-idb/prisma-idb/blob/main/README.md" label="Docs" title="Docs">
            <BookOpenText className="size-4" />
          </IconLink>

          <Button variant="outline" size="icon" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
            {themeMode === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BenchmarkDashboardHero({ controller }: SectionProps) {
  const { selectedRun, historyCount, exportRun, clearHistory } = controller;
  return (
    <header className="mb-6 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-3">
        <Badge variant="secondary">Performance Health Dashboard</Badge>
        <h1 className="text-foreground text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          Understand How Fast Your App Feels
        </h1>
        <p className="text-muted-foreground max-w-3xl text-sm">
          This page measures common app actions and translates numbers into what users are likely to feel. Lower latency
          means quicker responses and smoother experience.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={exportRun} disabled={!selectedRun}>
          <Download className="mr-1.5 size-4" /> Export JSON
        </Button>
        <Button variant="ghost" size="sm" onClick={clearHistory} disabled={historyCount === 0}>
          <Trash2 className="mr-1.5 size-4" /> Clear
        </Button>
      </div>
    </header>
  );
}

export function BenchmarkDashboardGuidanceCards() {
  return (
    <section className="mb-6 grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>What This Means</CardTitle>
          <CardDescription>Latency tells you how long users wait per action.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
            <li>Under 20 ms typically feels instant.</li>
            <li>60-150 ms can feel slightly delayed.</li>
            <li>Higher p95 means some users may consistently feel lag.</li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recommended Preset</CardTitle>
          <CardDescription>Balanced for CI signal and runtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
            <li>Dataset size: {BENCHMARK_DEFAULT_CONFIG.datasetSize.toLocaleString("en-US")} rows</li>
            <li>Warmup: {BENCHMARK_DEFAULT_CONFIG.warmupRuns} runs</li>
            <li>Measured: {BENCHMARK_DEFAULT_CONFIG.measuredRuns} runs</li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Comparison Rule</CardTitle>
          <CardDescription>Use same browser and machine profile.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
            <li>Compare against baseline on the same environment.</li>
            <li>Focus on p95 changes first for user-facing impact.</li>
            <li>Use multiple runs to reduce random noise.</li>
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}

export function BenchmarkRunSettingsCard({ controller }: SectionProps) {
  const {
    datasetSize,
    warmupRunsInput,
    measuredRunsInput,
    isRunning,
    progress,
    progressPercent,
    etaLabel,
    error,
    setDatasetSize,
    setWarmupRunsInput,
    setMeasuredRunsInput,
    executeBenchmarks,
    cancelBenchmarks,
  } = controller;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Run Settings</CardTitle>
        <CardDescription>Choose workload size and repeat count, then run the full benchmark suite.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-12">
          <div className="grid gap-2 md:col-span-3">
            <Label htmlFor="dataset-size">Dataset size</Label>
            <Select
              value={String(datasetSize)}
              onValueChange={(value) => setDatasetSize(Number(value))}
              disabled={isRunning}
            >
              <SelectTrigger id="dataset-size" className="w-full" size="default">
                <SelectValue placeholder="Select dataset size" />
              </SelectTrigger>
              <SelectContent>
                {BENCHMARK_DATASET_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size.toLocaleString("en-US")} rows
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2 md:col-span-3">
            <Label htmlFor="warmup-runs">Warmup runs</Label>
            <Input
              id="warmup-runs"
              type="number"
              min={BENCHMARK_LIMITS.minWarmupRuns}
              max={BENCHMARK_LIMITS.maxWarmupRuns}
              value={warmupRunsInput}
              onChange={(event) => setWarmupRunsInput(event.target.value)}
              disabled={isRunning}
            />
          </div>

          <div className="grid gap-2 md:col-span-3">
            <Label htmlFor="measured-runs">Measured runs</Label>
            <Input
              id="measured-runs"
              type="number"
              min={BENCHMARK_LIMITS.minMeasuredRuns}
              max={BENCHMARK_LIMITS.maxMeasuredRuns}
              value={measuredRunsInput}
              onChange={(event) => setMeasuredRunsInput(event.target.value)}
              disabled={isRunning}
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 md:col-span-3">
            <Button className="w-full min-w-0" onClick={() => void executeBenchmarks()} disabled={isRunning}>
              {isRunning ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              {isRunning ? "Running benchmarks..." : "Run benchmarks"}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={cancelBenchmarks}
              disabled={!isRunning}
              aria-label="Cancel benchmark run"
              title="Cancel benchmark run"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {progress && (
          <div className="mt-4 space-y-2" role="status" aria-live="polite" aria-atomic="true">
            <Progress value={progressPercent}>
              <ProgressLabel>{progress.currentOperationLabel}</ProgressLabel>
              <span className="text-muted-foreground ms-auto text-sm tabular-nums">
                {progress.completedSteps}/{progress.totalSteps} {progress.phase === "warmup" ? "warmup" : "measure"}
              </span>
            </Progress>
            <p className="text-muted-foreground text-xs">{etaLabel}</p>
          </div>
        )}
        {error && (
          <p className="text-destructive mt-3 text-sm" role="alert" aria-atomic="true">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function BenchmarkRunOverview({ controller }: SectionProps) {
  const { selectedRun, operationCount, runInsights, historyCount } = controller;
  return (
    <section className="mb-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader>
          <CardTitle>Total Run Time</CardTitle>
          <CardDescription>How long the complete suite took.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-foreground text-2xl font-semibold">
            {selectedRun ? formatMs(selectedRun.totalDurationMs) : "-"}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Scenario Coverage</CardTitle>
          <CardDescription>How many interaction patterns were tested.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-foreground text-2xl font-semibold">{operationCount || "-"}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>User Experience Outlook</CardTitle>
          <CardDescription>Based on median p95 latency.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-foreground text-sm font-medium">
            {runInsights?.overallExperience ?? "Run a benchmark to see this."}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Consistency</CardTitle>
          <CardDescription>How stable the results are run to run.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-foreground text-2xl font-semibold">{runInsights?.consistency ?? "-"}</p>
          <p className="text-muted-foreground mt-1 text-xs">Saved history: {historyCount}</p>
        </CardContent>
      </Card>
    </section>
  );
}

export function BenchmarkRunDetails({ controller }: SectionProps) {
  const { selectedRun, runInsights } = controller;
  if (!selectedRun || !runInsights) return null;

  const { fastestByMean, slowestByMean } = runInsights;

  return (
    <>
      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Fastest Scenario</CardTitle>
            <CardDescription>Lowest average latency in this run.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-foreground font-medium">{fastestByMean.label}</p>
            <p className="text-muted-foreground text-sm">{formatMs(fastestByMean.summary.meanMs)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Most Expensive Scenario</CardTitle>
            <CardDescription>Highest average latency in this run.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-foreground font-medium">{slowestByMean.label}</p>
            <p className="text-muted-foreground text-sm">{formatMs(slowestByMean.summary.meanMs)}</p>
          </CardContent>
        </Card>
      </section>

      <section className="mb-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Latency (mean vs p95)</CardTitle>
            <CardDescription>
              Mean is average speed. p95 shows near worst-case user wait time and is often the most useful signal.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LatencyChart operations={selectedRun.operations} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Throughput (ops/s)</CardTitle>
            <CardDescription>Higher values mean the operation can be processed more times per second.</CardDescription>
          </CardHeader>
          <CardContent>
            <ThroughputChart operations={selectedRun.operations} />
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Operation Summary</CardTitle>
          <CardDescription>
            This table combines technical metrics with a plain-language impact label for each benchmarked action.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Operation</TableHead>
                  <TableHead>Average</TableHead>
                  <TableHead>p95</TableHead>
                  <TableHead>Throughput</TableHead>
                  <TableHead>User Impact</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedRun.operations.map((operation) => (
                  <TableRow key={operation.operationId}>
                    <TableCell>{operation.label}</TableCell>
                    <TableCell>{formatMs(operation.summary.meanMs)}</TableCell>
                    <TableCell>{formatMs(operation.summary.p95Ms)}</TableCell>
                    <TableCell>{formatOpsPerSecond(operation.summary.opsPerSecond)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{userImpactLabel(operation.summary.p95Ms)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
