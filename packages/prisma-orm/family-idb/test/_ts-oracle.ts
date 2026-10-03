// Spike-only: runs the legacy `defineContract` next to the current one.
// Success compares whole contracts (minus the `execution` block the new
// builder adds for `fieldDefaults`); failure compares throws-vs-not.
import { appendFileSync } from "node:fs";
import { expect } from "vitest";
import { defineContract as current } from "../src/core/contract-builder";
import { defineContract as legacy } from "../src/core/contract-builder.legacy";

const NOTES_FILE = process.env["ORACLE_NOTES"];
function note(kind: string, detail: unknown): void {
  if (NOTES_FILE)
    appendFileSync(NOTES_FILE, JSON.stringify({ kind, test: expect.getState().currentTestName, detail }) + "\n");
}

function run(
  fn: () => unknown
): { ok: true; value: unknown; warnings: unknown[][] } | { ok: false; error: string; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    return { ok: true, value: fn(), warnings };
  } catch (e) {
    return { ok: false, error: String((e as Error).message), warnings };
  } finally {
    console.warn = original;
  }
}

export const defineContract: typeof current = ((input: never, options?: never) => {
  const was = run(() => legacy(input, options));
  const now = run(() => current(input, options));
  for (const args of now.warnings) console.warn(...args);

  expect(now.ok, `oracle: ok (was: ${was.ok ? "ok" : was.error}; now: ${now.ok ? "ok" : now.error})`).toBe(was.ok);
  if (!was.ok || !now.ok) {
    if (!was.ok && !now.ok && was.error !== now.error) note("message", { was: was.error, now: now.error });
    expect(now.warnings, "oracle: warnings").toEqual(was.warnings);
    if (!now.ok) throw new Error(now.error);
    return now.value;
  }
  expect(now.warnings, "oracle: warnings").toEqual(was.warnings);
  const { execution, ...rest } = now.value as Record<string, unknown>;
  if (execution !== undefined) note("execution-added", execution);
  expect(rest, "oracle: contract").toEqual(was.value);
  if (JSON.stringify(rest) !== JSON.stringify(was.value)) note("contract-key-order", null);
  return now.value;
}) as typeof current;
