import path from "path";
import type { GeneratedProject } from "./_generate";

/** The part of a push result the ownership tests read. */
export interface PushResult {
  appliedChangelogId: string | null;
  error: { type: string; retryable: boolean } | null;
}

/** The generated `server/batch-processor.ts` entry points, typed for the tests that call them. */
export interface BatchProcessor {
  applyPush(options: { events: unknown[]; scopeKey: string; prisma: unknown }): Promise<PushResult[]>;
  pullAndMaterializeLogs(options: {
    prisma: unknown;
    scopeKey: string;
  }): Promise<Array<{ keyPath: string[]; record: { id: string } | null }>>;
}

/** Imports the generated batch processor so a test can run it. */
export async function loadBatchProcessor(project: GeneratedProject): Promise<BatchProcessor> {
  return import(/* @vite-ignore */ path.join(project.idbDir, "server", "batch-processor.ts"));
}
