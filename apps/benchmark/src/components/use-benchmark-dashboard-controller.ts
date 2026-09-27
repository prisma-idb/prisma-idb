import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeBenchmarkConfigInputs } from "@prisma-idb/benchmark-kit";
import { runBenchmarkSuite } from "@/lib/benchmark/runner";
import {
  BENCHMARK_DEFAULT_CONFIG,
  type BenchmarkConfig,
  type BenchmarkOperationResult,
  type BenchmarkProgress,
  type BenchmarkRunResult,
} from "@/lib/benchmark/types";
import { downloadTextFile } from "@/lib/download";
import { clearBenchmarkHistory, getBenchmarkHistory, saveBenchmarkRun } from "@/lib/storage/history";

export type BenchmarkThemeMode = "dark" | "light";

export interface BenchmarkRunInsights {
  fastestByMean: BenchmarkOperationResult;
  slowestByMean: BenchmarkOperationResult;
  overallExperience: string;
  consistency: string;
}

function overallExperienceLabel(medianP95Ms: number): string {
  if (medianP95Ms < 20) return "Great: interactions should feel instant for most users.";
  if (medianP95Ms < 60) return "Good: interactions should feel responsive.";
  if (medianP95Ms < 150) return "Fair: users may occasionally notice short delay.";
  return "Needs work: users are likely to feel lag.";
}

function consistencyLabel(avgJitterRatio: number): string {
  if (avgJitterRatio < 0.08) return "Very stable";
  if (avgJitterRatio < 0.18) return "Reasonably stable";
  if (avgJitterRatio < 0.3) return "Moderate variance";
  return "High variance";
}

function formatEta(ms: number | null): string {
  if (ms === null) return "Calculating ETA...";
  if (ms <= 0) return "Finishing up...";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `About ${sec}s left`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `About ${min}m ${rem}s left`;
}

type AutoStartInit = { kind: "none" } | { kind: "error"; message: string } | { kind: "ready"; config: BenchmarkConfig };

function getInitialTheme(): BenchmarkThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem("benchmark-theme");
  return stored === "light" || stored === "dark" ? stored : "dark";
}

function getAutoStartInit(): AutoStartInit {
  if (typeof window === "undefined") return { kind: "none" };
  const params = new URLSearchParams(window.location.search);
  if (!params.has("autoStart")) return { kind: "none" };
  const result = sanitizeBenchmarkConfigInputs({
    datasetSize: params.get("datasetSize") ?? BENCHMARK_DEFAULT_CONFIG.datasetSize,
    warmupRuns: params.get("warmupRuns") ?? BENCHMARK_DEFAULT_CONFIG.warmupRuns,
    measuredRuns: params.get("measuredRuns") ?? BENCHMARK_DEFAULT_CONFIG.measuredRuns,
  });
  return result.ok ? { kind: "ready", config: result.config } : { kind: "error", message: result.error };
}

export function useBenchmarkDashboardController() {
  // The dashboard is loaded with ssr:false (dynamic import in page.tsx),
  // so these initializers safely access window/localStorage/location.
  const [autoStart] = useState<AutoStartInit>(getAutoStartInit);
  const autoStartCfg = autoStart.kind === "ready" ? autoStart.config : null;

  const [datasetSize, setDatasetSize] = useState<number>(
    autoStartCfg?.datasetSize ?? BENCHMARK_DEFAULT_CONFIG.datasetSize
  );
  const [warmupRunsInput, setWarmupRunsInput] = useState<string>(
    String(autoStartCfg?.warmupRuns ?? BENCHMARK_DEFAULT_CONFIG.warmupRuns)
  );
  const [measuredRunsInput, setMeasuredRunsInput] = useState<string>(
    String(autoStartCfg?.measuredRuns ?? BENCHMARK_DEFAULT_CONFIG.measuredRuns)
  );
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [activeRun, setActiveRun] = useState<BenchmarkRunResult | null>(null);
  const [history, setHistory] = useState<BenchmarkRunResult[]>(getBenchmarkHistory);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const [error, setError] = useState<string>(autoStart.kind === "error" ? autoStart.message : "");
  const [themeMode, setThemeMode] = useState<BenchmarkThemeMode>(getInitialTheme);
  const [runStartedAtMs, setRunStartedAtMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);

  const runAbortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const executeBenchmarksRef = useRef<((config?: BenchmarkConfig) => Promise<void>) | undefined>(undefined);
  const autoStartFiredRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      runAbortControllerRef.current?.abort();
      runAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeMode === "dark");
  }, [themeMode]);

  useEffect(() => {
    if (!isRunning) return;

    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isRunning]);

  const selectedRun = activeRun ?? history[0] ?? null;
  const historyCount = history.length;
  const operationCount = selectedRun?.operations.length ?? 0;

  const runInsights = useMemo<BenchmarkRunInsights | null>(() => {
    if (!selectedRun || selectedRun.operations.length === 0) return null;

    const operations = selectedRun.operations;
    const fastestByMean = operations.reduce((best, current) =>
      current.summary.meanMs < best.summary.meanMs ? current : best
    );
    const slowestByMean = operations.reduce((best, current) =>
      current.summary.meanMs > best.summary.meanMs ? current : best
    );

    const sortedP95 = operations
      .map((operation) => operation.summary.p95Ms)
      .slice()
      .sort((a, b) => a - b);
    const middleIndex = Math.floor(sortedP95.length / 2);
    const medianP95 =
      sortedP95.length === 0
        ? 0
        : sortedP95.length % 2 === 1
          ? (sortedP95[middleIndex] ?? 0)
          : ((sortedP95[middleIndex - 1] ?? 0) + (sortedP95[middleIndex] ?? 0)) / 2;

    const avgJitterRatio =
      operations.reduce((sum, operation) => {
        const mean = Math.max(0.0001, operation.summary.meanMs);
        return sum + operation.summary.stdDevMs / mean;
      }, 0) / operations.length;

    return {
      fastestByMean,
      slowestByMean,
      overallExperience: overallExperienceLabel(medianP95),
      consistency: consistencyLabel(avgJitterRatio),
    };
  }, [selectedRun]);

  const progressPercent = progress ? (progress.completedSteps / Math.max(1, progress.totalSteps)) * 100 : 0;

  const etaLabel = useMemo(() => {
    if (!progress || !runStartedAtMs || progress.completedSteps === 0) return formatEta(null);
    const elapsed = now - runStartedAtMs;
    const projectedTotal = (elapsed / progress.completedSteps) * progress.totalSteps;
    const remaining = projectedTotal - elapsed;
    return formatEta(Number.isFinite(remaining) ? Math.max(0, remaining) : null);
  }, [progress, runStartedAtMs, now]);

  function toggleTheme() {
    const nextTheme: BenchmarkThemeMode = themeMode === "dark" ? "light" : "dark";
    setThemeMode(nextTheme);
    window.localStorage.setItem("benchmark-theme", nextTheme);
  }

  async function executeBenchmarks(configOverride?: BenchmarkConfig) {
    if (isRunning || runAbortControllerRef.current) {
      return;
    }

    setError("");

    const sanitized = configOverride
      ? { ok: true as const, config: configOverride }
      : sanitizeBenchmarkConfigInputs({
          datasetSize,
          warmupRuns: warmupRunsInput,
          measuredRuns: measuredRunsInput,
        });

    if (!sanitized.ok) {
      setError(sanitized.error);
      return;
    }

    const sanitizedConfig: BenchmarkConfig = sanitized.config;
    setDatasetSize(sanitizedConfig.datasetSize);
    setWarmupRunsInput(String(sanitizedConfig.warmupRuns));
    setMeasuredRunsInput(String(sanitizedConfig.measuredRuns));

    const controller = new AbortController();
    runAbortControllerRef.current = controller;

    setIsRunning(true);
    setRunStartedAtMs(Date.now());
    setProgress({
      completedSteps: 0,
      totalSteps: 1,
      currentOperationLabel: "Preparing benchmark environment",
      phase: "warmup",
    });

    try {
      const run = await runBenchmarkSuite(
        sanitizedConfig,
        (nextProgress) => {
          if (!isMountedRef.current || controller !== runAbortControllerRef.current) return;
          setProgress(nextProgress);
        },
        controller.signal
      );

      if (!isMountedRef.current || controller !== runAbortControllerRef.current) return;

      setActiveRun(run);
      setHistory(saveBenchmarkRun(run));
    } catch (runError) {
      if (!isMountedRef.current || controller !== runAbortControllerRef.current) return;

      if (runError instanceof DOMException && runError.name === "AbortError") {
        setError("Benchmark run was cancelled.");
      } else {
        setError(runError instanceof Error ? runError.message : "Failed to execute benchmark run");
      }
    } finally {
      const isCurrentRun = controller === runAbortControllerRef.current;
      if (isCurrentRun) {
        runAbortControllerRef.current = null;
      }

      if (isMountedRef.current && isCurrentRun) {
        setIsRunning(false);
        setProgress(null);
        setRunStartedAtMs(null);
      }
    }
  }

  function cancelBenchmarks() {
    runAbortControllerRef.current?.abort();
  }

  // Keep ref in sync so the auto-start effect can call the latest version
  useEffect(() => {
    executeBenchmarksRef.current = executeBenchmarks;
  });

  // Auto-start from URL params (for CI): /?autoStart&datasetSize=1000&warmupRuns=2&measuredRuns=20
  useEffect(() => {
    if (autoStart.kind !== "ready" || autoStartFiredRef.current) return;
    autoStartFiredRef.current = true;
    void executeBenchmarksRef.current?.(autoStart.config);
  }, [autoStart]);

  function exportRun() {
    if (!selectedRun) return;
    const stamp = selectedRun.completedAt.replace(/[:.]/g, "-");
    downloadTextFile(`benchmark-${stamp}.json`, JSON.stringify(selectedRun, null, 2), "application/json");
  }

  function clearHistory() {
    clearBenchmarkHistory();
    setHistory([]);
    setActiveRun(null);
  }

  return {
    datasetSize,
    warmupRunsInput,
    measuredRunsInput,
    isRunning,
    selectedRun,
    historyCount,
    progress,
    error,
    themeMode,
    operationCount,
    runInsights,
    activeRun,
    progressPercent,
    etaLabel,
    setDatasetSize,
    setWarmupRunsInput,
    setMeasuredRunsInput,
    executeBenchmarks,
    cancelBenchmarks,
    clearHistory,
    exportRun,
    toggleTheme,
  };
}

export type BenchmarkDashboardController = ReturnType<typeof useBenchmarkDashboardController>;
