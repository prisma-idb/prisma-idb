import type { BenchmarkRunResult } from "@/lib/benchmark/types";

const STORAGE_KEY = "prisma-idb-benchmark-history-v1";
const MAX_RUNS = 30;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function looksLikeRunResult(value: unknown): value is BenchmarkRunResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.completedAt === "string" &&
    Array.isArray(obj.operations) &&
    typeof obj.config === "object" &&
    obj.config !== null
  );
}

function parseStoredHistory(raw: string): BenchmarkRunResult[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(looksLikeRunResult);
  } catch {
    return [];
  }
}

export function getBenchmarkHistory(): BenchmarkRunResult[] {
  if (!isBrowser()) return [];

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }

  if (!raw) return [];

  return parseStoredHistory(raw);
}

export function saveBenchmarkRun(run: BenchmarkRunResult): BenchmarkRunResult[] {
  const existing = getBenchmarkHistory();
  const next = [run, ...existing].slice(0, MAX_RUNS);

  if (isBrowser()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.error(`Failed to persist benchmark history (key: ${STORAGE_KEY}, run: ${run.id}):`, error);
    }
  }

  return next;
}

export function clearBenchmarkHistory() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error(`Failed to clear benchmark history (key: ${STORAGE_KEY}):`, error);
  }
}
