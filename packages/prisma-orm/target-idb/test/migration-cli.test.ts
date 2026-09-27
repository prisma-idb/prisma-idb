/**
 * Tests for the `MigrationCLI` shim.
 *
 * The shim is no-op when `isDirectEntrypoint` returns false (vitest's
 * runner binary is `process.argv[1]`, not the test file), so we mock the
 * entrypoint check to force the active branch and assert side effects.
 *
 * Coverage:
 * - No-op when `isDirectEntrypoint` returns false (imported, not executed)
 * - Writes `ops.json` + `migration.json` next to the source file
 * - `--dry-run` prints both files to stdout and writes nothing
 * - Preserves `createdAt` and other CLI-owned metadata fields across re-runs
 * - `--help` prints usage and writes nothing
 * - Warns on stderr when the migration drops a store
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdbMigration } from "../src/core/idb-migration";
import { createObjectStoreOp, dropObjectStoreOp, type IdbDdlOp } from "../src/core/migration-factories";

vi.mock("@prisma/orm-toolchain/migration-tools/migration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prisma/orm-toolchain/migration-tools/migration")>();
  return {
    ...actual,
    isDirectEntrypoint: vi.fn(() => true),
  };
});

// Import after the mock is registered so MigrationCLI sees the mocked
// `isDirectEntrypoint`.
const { MigrationCLI } = await import("../src/core/migration-cli");
const { isDirectEntrypoint } = await import("@prisma/orm-toolchain/migration-tools/migration");

class BaselineMigration extends IdbMigration {
  override describe() {
    return { from: null, to: "sha256:test-to-hash" };
  }
  override get operations(): readonly IdbDdlOp[] {
    return [createObjectStoreOp("users", { keyPath: "id" })];
  }
}

class DropMigration extends IdbMigration {
  override describe() {
    return { from: "sha256:test-from-hash", to: "sha256:test-to-hash" };
  }
  override get operations(): readonly IdbDdlOp[] {
    return [dropObjectStoreOp("drafts")];
  }
}

let tmpDir: string;
let migrationFileUrl: string;
let stdoutChunks: string[];
let originalArgv: string[];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "idb-migration-cli-test-"));
  // The "url" is what `import.meta.url` would be inside the fake migration.ts —
  // a file URL pointing at a path inside tmpDir. We don't need the file to
  // actually exist; the shim only reads its directory.
  migrationFileUrl = pathToFileURL(join(tmpDir, "migration.ts")).href;

  stdoutChunks = [];
  originalArgv = process.argv;
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  process.argv = originalArgv;
  vi.clearAllMocks();
});

describe("MigrationCLI", () => {
  it("returns 0 without side effects when isDirectEntrypoint returns false", async () => {
    vi.mocked(isDirectEntrypoint).mockReturnValueOnce(false);
    process.argv = ["node", "/some/other/file.ts"];

    const exitCode = await MigrationCLI.run(migrationFileUrl, BaselineMigration);

    expect(exitCode).toBe(0);
    expect(existsSync(join(tmpDir, "ops.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "migration.json"))).toBe(false);
    expect(stdoutChunks.join("")).toBe("");
  });

  it("writes ops.json and migration.json next to the source file", async () => {
    process.argv = ["node", "/migration.ts"];

    const exitCode = await MigrationCLI.run(migrationFileUrl, BaselineMigration);
    expect(exitCode).toBe(0);

    const opsPath = join(tmpDir, "ops.json");
    const metaPath = join(tmpDir, "migration.json");
    expect(existsSync(opsPath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    const ops = JSON.parse(readFileSync(opsPath, "utf-8")) as unknown[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "createObjectStore", storeName: "users" });

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      from: string | null;
      to: string;
      migrationHash: string;
    };
    expect(meta.from).toBeNull();
    expect(meta.to).toBe("sha256:test-to-hash");
    expect(meta.migrationHash).toMatch(/^[0-9a-f]{64}$/);

    expect(stdoutChunks.join("")).toContain("Wrote ops.json + migration.json to");
  });

  it("--dry-run prints both files to stdout without writing", async () => {
    process.argv = ["node", "/migration.ts", "--dry-run"];

    const exitCode = await MigrationCLI.run(migrationFileUrl, BaselineMigration);
    expect(exitCode).toBe(0);

    expect(existsSync(join(tmpDir, "ops.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "migration.json"))).toBe(false);

    const out = stdoutChunks.join("");
    expect(out).toContain("--- migration.json ---");
    expect(out).toContain("--- ops.json ---");
    expect(out).toContain("sha256:test-to-hash");
  });

  it("preserves createdAt across re-runs", async () => {
    // First run: writes a fresh migration.json with a synthesized createdAt.
    process.argv = ["node", "/migration.ts"];
    await MigrationCLI.run(migrationFileUrl, BaselineMigration);
    const metaPath = join(tmpDir, "migration.json");
    const firstMeta = JSON.parse(readFileSync(metaPath, "utf-8")) as { createdAt: string };
    expect(firstMeta.createdAt).toBeDefined();

    // Hand-edit createdAt to simulate a previously-scaffolded package.
    const seeded = { ...firstMeta, createdAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(metaPath, JSON.stringify(seeded, null, 2), "utf-8");

    // Second run: should pick up and preserve the existing createdAt.
    stdoutChunks = [];
    await MigrationCLI.run(migrationFileUrl, BaselineMigration);
    const secondMeta = JSON.parse(readFileSync(metaPath, "utf-8")) as { createdAt: string };
    expect(secondMeta.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("warns on stderr when the migration drops a store, and not otherwise", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.argv = ["node", "/migration.ts", "--dry-run"];
      await MigrationCLI.run(migrationFileUrl, BaselineMigration);
      expect(stderr).not.toHaveBeenCalled();

      await MigrationCLI.run(migrationFileUrl, DropMigration);
      const warning = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(warning).toContain("this migration deletes data");
      expect(warning).toContain("  - drafts\n");
    } finally {
      stderr.mockRestore();
    }
  });

  it("--help prints usage and writes no files", async () => {
    process.argv = ["node", "/migration.ts", "--help"];

    const exitCode = await MigrationCLI.run(migrationFileUrl, BaselineMigration);
    expect(exitCode).toBe(0);

    expect(existsSync(join(tmpDir, "ops.json"))).toBe(false);
    expect(stdoutChunks.join("")).toContain("Usage: node migration.ts");
  });
});
