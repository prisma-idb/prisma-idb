// Spike-only: runs the legacy PSL interpreter next to the current one and
// fails when they disagree. Diagnostics compare on code, sourceId and span
// (in order); messages are recorded as notes, not failures.
import { appendFileSync } from "node:fs";
import { expect } from "vitest";
import type { SymbolTable } from "@prisma/orm-framework/psl-parser";
import type { InterpretPslOptions } from "../src/core/psl-interpreter";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import { interpretPslDocumentToIdbContract as legacyInterpret } from "../src/core/psl-interpreter.legacy";

const NOTES_FILE = process.env["ORACLE_NOTES"];

function note(kind: string, detail: unknown): void {
  if (NOTES_FILE)
    appendFileSync(NOTES_FILE, JSON.stringify({ kind, test: expect.getState().currentTestName, detail }) + "\n");
}

function captureWarnings<T>(run: () => T): { result: T; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = original;
  }
}

type Diag = { code: string; message: string; sourceId?: string; span?: unknown };

/**
 * Fixtures where the new interpreter deliberately differs. Legacy reports
 * IDB_UNRESOLVED_BACKRELATION as a side effect of an earlier error on the
 * FK field (the FK was never registered); the lowering still sees the
 * relation and reports what is actually wrong with it, at the same span.
 */
const INTENDED_DIAGNOSTIC_CHANGES = new Set([
  "errors when excluding a scalar field that backs a relation's FK",
  "errors when @idb.exclude is placed directly on a relation field",
]);

const shape = (d: Diag) => ({ code: d.code, sourceId: d.sourceId, span: d.span });
const key = (d: Diag) => JSON.stringify(shape(d));

export function interpretWithOracle(table: SymbolTable, sourceId: string, options?: InterpretPslOptions) {
  const legacy = captureWarnings(() => legacyInterpret(table, sourceId, options));
  const current = captureWarnings(() => interpretPslDocumentToIdbContract(table, sourceId, options));

  // Pass through one set of warnings so the suite's warn spy sees what it did before.
  for (const args of current.warnings) console.warn(...args);

  expect(current.warnings, "oracle: warnings").toEqual(legacy.warnings);
  expect(current.result.ok, "oracle: ok").toBe(legacy.result.ok);

  if (legacy.result.ok && current.result.ok) {
    expect(current.result.value, "oracle: contract").toEqual(legacy.result.value);
    if (JSON.stringify(current.result.value) !== JSON.stringify(legacy.result.value)) {
      note("contract-key-order", null);
    }
  } else if (!legacy.result.ok && !current.result.ok) {
    const was = legacy.result.failure.diagnostics as Diag[];
    const now = current.result.failure.diagnostics as Diag[];
    const name = expect.getState().currentTestName ?? "";
    if ([...INTENDED_DIAGNOSTIC_CHANGES].some((t) => name.endsWith(t))) {
      note("intended-change", { was: was.map((d) => [d.code, d.span]), now: now.map((d) => [d.code, d.span]) });
      return current.result;
    }
    // Same multiset is a hard requirement; same order is recorded.
    expect(now.map(key).sort(), "oracle: diagnostics (unordered)").toEqual(was.map(key).sort());
    if (now.map(key).join() !== was.map(key).join()) {
      note("diagnostic-order", { was: was.map((d) => d.code), now: now.map((d) => d.code) });
    }
    for (const d of now) {
      const match = was.find((w) => key(w) === key(d));
      if (match && match.message !== d.message) note("message", { code: d.code, was: match.message, now: d.message });
    }
  }
  return current.result;
}
