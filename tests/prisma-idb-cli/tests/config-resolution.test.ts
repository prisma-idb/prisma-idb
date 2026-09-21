/**
 * CLI regression tests for config-driven path resolution.
 *
 * `prisma-idb` used to hardcode `src/lib/prisma/contract.json` and
 * `migrations/` as its only defaults, ignoring whatever `prisma.config.ts`
 * actually declared via `contract.output` / `migrations.dir`. These tests
 * cover the fix: paths come from the loaded config when not passed
 * explicitly, explicit flags still win, and a mismatched/missing config
 * fails clearly instead of silently falling back to the old hardcoded path.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, setupTmpProject, writeMinimalIdbConfig } from "./_helpers";

const MINIMAL_CONTRACT = { storage: { storageHash: "sha256:cfg-test", stores: { users: { keyPath: "id" } } } };

async function writeContractAt(cwd: string, relPath: string, contract: unknown = MINIMAL_CONTRACT): Promise<void> {
  const full = join(cwd, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(contract, null, 2), "utf-8");
}

describe("prisma-idb — config-driven path resolution", () => {
  it("honors a custom contract.output / migrations.dir from prisma.config.ts with no flags", async () => {
    const cwd = await setupTmpProject("cfg-custom-paths");
    // Overwrite the default config setupTmpProject wrote with a custom layout.
    await writeMinimalIdbConfig(cwd, { contractOutput: "src/contract.json", migrationsDir: "db-migrations" });
    await writeContractAt(cwd, "src/contract.json");

    const { stderr, exitCode } = await cli(["migration", "plan"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("db-migrations/app/");

    const entries = await getMigrationDirsAt(cwd, "db-migrations");
    expect(entries).toHaveLength(1);
  });

  it("regression: reproduces sync-extension-idb's exact config shape (contract.output at src/, extension space)", async () => {
    // packages/prisma-orm/sync-extension-idb/prisma.config.ts declares
    // contract: typescriptContract(syncContract, "src/contract.json") with no
    // src/lib/prisma/ anywhere — its "migration:plan" script
    // (`prisma-idb migration plan --space idb-sync`, no --contract flag)
    // used to ENOENT against the CLI's old hardcoded src/lib/prisma/contract.json
    // default. This reproduces that shape end to end.
    const cwd = await setupTmpProject("cfg-sync-extension-shape");
    await writeMinimalIdbConfig(cwd, { contractOutput: "src/contract.json", migrationsDir: "migrations" });
    await writeContractAt(cwd, "src/contract.json");

    const { stderr, exitCode } = await cli(["migration", "plan", "--space", "idb-sync"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Generated baseline migration");

    const headRef = JSON.parse(await readFile(join(cwd, "migrations", "refs", "head.json"), "utf-8")) as {
      hash: string;
    };
    expect(headRef.hash).toBe(MINIMAL_CONTRACT.storage.storageHash);
  });

  it("explicit --contract / --migrations-dir override a present config", async () => {
    const cwd = await setupTmpProject("cfg-explicit-override");
    // Default config points at src/lib/prisma/contract.json + migrations/,
    // but we pass flags pointing somewhere else entirely — and never even
    // create a contract.json at the config's declared location.
    await writeContractAt(cwd, "elsewhere/contract.json");

    const { exitCode } = await cli(
      ["migration", "plan", "--contract", "elsewhere/contract.json", "--migrations-dir", "elsewhere-migrations"],
      { cwd }
    );
    expect(exitCode).toBe(0);

    const entries = await getMigrationDirsAt(cwd, "elsewhere-migrations");
    expect(entries).toHaveLength(1);
  });

  it("fails clearly when the config's family isn't idb", async () => {
    const cwd = await setupTmpProject("cfg-family-mismatch");
    await writeMinimalIdbConfig(cwd, { familyId: "postgres" });

    const { stderr, exitCode } = await cli(["migration", "plan"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toContain('expected "idb"');
  });

  it("fails clearly when no prisma.config.ts exists and no path flags are given", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    // A bare tmpdir with no config file at all — not setupTmpProject, which
    // always writes one.
    const cwd = await mkdtemp(join(tmpdir(), "idb-cli-test-cfg-missing-"));

    const { stderr, exitCode } = await cli(["migration", "plan"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("migration contract-space defaults --out to be colocated with the resolved contract path", async () => {
    const cwd = await setupTmpProject("cfg-contract-space-out");
    await writeMinimalIdbConfig(cwd, { contractOutput: "src/contract.json", migrationsDir: "migrations" });
    await writeContractAt(cwd, "src/contract.json");

    const { exitCode } = await cli(["migration", "plan"], { cwd });
    expect(exitCode).toBe(0);

    const spaceResult = await cli(["migration", "contract-space"], { cwd });
    expect(spaceResult.exitCode).toBe(0);

    // Colocated with src/contract.json, NOT the old hardcoded src/lib/prisma/ default.
    const out = await readFile(join(cwd, "src", "contract-space.generated.ts"), "utf-8");
    expect(out).toContain("THIS FILE IS AUTO-GENERATED");
  });

  it("an explicit relative --out writes to a not-yet-existing nested directory", async () => {
    const cwd = await setupTmpProject("cfg-contract-space-explicit-out");
    await writeMinimalIdbConfig(cwd, { contractOutput: "src/contract.json", migrationsDir: "migrations" });
    await writeContractAt(cwd, "src/contract.json");

    const { exitCode } = await cli(["migration", "plan"], { cwd });
    expect(exitCode).toBe(0);

    const spaceResult = await cli(["migration", "contract-space", "--out", "generated/space.ts"], { cwd });
    expect(spaceResult.exitCode).toBe(0);

    const out = await readFile(join(cwd, "generated", "space.ts"), "utf-8");
    expect(out).toContain("THIS FILE IS AUTO-GENERATED");
  });
});

async function getMigrationDirsAt(cwd: string, migrationsDir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const appDir = join(cwd, migrationsDir, "app");
  const entries = await readdir(appDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
