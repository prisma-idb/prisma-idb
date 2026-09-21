import type { Presentations } from "@prisma/cli-engine";

/**
 * Collects a wrapped core function's `out`/`err` sink writes so a command
 * handler can present them through the engine instead of writing to the
 * real `process.stdout`/`process.stderr` directly (which would corrupt
 * `--json` mode and be invisible to `createTestCli`'s in-memory harness).
 */
export interface CollectingSink {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Every line written to either sink, in order, newline-split. */
  lines(): readonly string[];
  /**
   * `lines()` joined back into text — the full collected log (progress
   * AND error detail, not just the `err`-only parts), for use as a
   * `CliStructuredError`'s `summary` on a nonzero exit. A wrapped function
   * writes its error explanation to `err` only after already writing
   * per-step progress to `out` (e.g. preflight's `"<dir> … "` / `"FAILED"`
   * pair) — using only the `err` writes would silently drop that context.
   */
  fullText(): string;
}

/**
 * Buffers writes the way a real stream does: a write with no trailing
 * newline (e.g. the wrapped functions' `out("  ${dirName} … ")` followed
 * later by a separate `out("ok\n")` call) stays pending and joins with
 * whatever arrives next, rather than becoming its own line. Splitting each
 * `out`/`err` call independently — the first cut of this — silently broke
 * exactly this pattern in `preflight.ts`'s per-package progress line.
 */
export function createCollectingSink(): CollectingSink {
  const completedLines: string[] = [];
  let buffer = "";

  function push(text: string): void {
    buffer += text;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.length > 0) completedLines.push(part);
    }
  }

  const lines = (): readonly string[] => (buffer.length > 0 ? [...completedLines, buffer] : completedLines);

  return {
    out: (text) => push(text),
    err: (text) => push(text),
    lines,
    fullText: () => lines().join("\n").trim(),
  };
}

/**
 * Renders collected lines as a `drawing` block (verbatim, no reflow) in
 * human mode; `stdout` stays empty since these commands carry no separate
 * machine-pipeable data channel beyond the human log itself.
 */
export function presentationsFromSink(sink: CollectingSink, exitCode: number): Presentations {
  const lines = sink.lines();
  return {
    human: () => (lines.length === 0 ? [] : [{ kind: "drawing", lines }]),
    stdout: () => [],
    json: () => ({ exitCode, lines }),
    next: () => [],
  };
}
