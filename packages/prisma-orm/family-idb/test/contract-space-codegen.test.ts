/**
 * Tests for the `migration contract-space` codegen.
 *
 * Coverage:
 * - Empty migrations dir → emits a module with `migrations: []` and writes
 *   an empty head.json.
 * - One package → emits import statements + the package, head.json points
 *   at the package's `to`.
 * - Two packages in chain order → emits both, head.json points at the
 *   last package's `to`.
 * - Broken chain (mismatched from/to) → throws with a clear message.
 * - Idempotent: re-running produces byte-identical output.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateContractSpace } from "../src/core/contract-space-codegen";

let cwd: string;
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "idb-codegen-test-"));
  // Set up the canonical layout the codegen expects by default.
  await mkdir(join(cwd, "migrations", "app"), { recursive: true });
  await mkdir(join(cwd, "src", "lib", "prisma"), { recursive: true });
  await writeFile(
    join(cwd, "src", "lib", "prisma", "contract.json"),
    JSON.stringify({ storage: { storageHash: "sha256:contract-x" } }),
    "utf-8"
  );

  // Silence stdout/stderr during tests.
  originalStdout = process.stdout.write.bind(process.stdout);
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

function defaultPaths(base: string): { migrationsDir: string; contractPath: string; outPath: string } {
  return {
    migrationsDir: join(base, "migrations"),
    contractPath: join(base, "src", "lib", "prisma", "contract.json"),
    outPath: join(base, "src", "lib", "prisma", "contract-space.generated.ts"),
  };
}

async function writePackage(opts: {
  dirName: string;
  from: string | null;
  to: string;
  migrationHash?: string;
  invariants?: readonly string[];
}): Promise<void> {
  const dir = join(cwd, "migrations", "app", opts.dirName);
  await mkdir(dir, { recursive: true });
  const metadata = {
    from: opts.from,
    to: opts.to,
    migrationHash: opts.migrationHash ?? `sha256:hash-${opts.dirName}`,
    providedInvariants: opts.invariants ?? [],
    createdAt: new Date(2026, 0, 1).toISOString(),
  };
  await writeFile(join(dir, "migration.json"), JSON.stringify(metadata), "utf-8");
  await writeFile(join(dir, "ops.json"), "[]", "utf-8");
}

describe("generateContractSpace", () => {
  it("emits an empty-migrations module when no packages exist", async () => {
    const exitCode = await generateContractSpace(defaultPaths(cwd));
    expect(exitCode).toBe(0);

    const out = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
    expect(out).toContain("THIS FILE IS AUTO-GENERATED");
    expect(out).toContain("import contractJson from");
    expect(out).toContain("migrations: [],");
    expect(out).toContain('hash: ""');
  });

  it("emits one import pair per package and inlines headRef pointing at the last package", async () => {
    await writePackage({ dirName: "0001_baseline", from: null, to: "sha256:A", invariants: ["inv-1"] });
    await writePackage({ dirName: "0002_addPosts", from: "sha256:A", to: "sha256:B" });

    const exitCode = await generateContractSpace(defaultPaths(cwd));
    expect(exitCode).toBe(0);

    const out = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
    expect(out).toContain("import mig_0001_baseline_meta");
    expect(out).toContain("import mig_0001_baseline_ops");
    expect(out).toContain("import mig_0002_addPosts_meta");
    expect(out).toContain("import mig_0002_addPosts_ops");
    expect(out).toContain('dirName: "0001_baseline"');
    expect(out).toContain('dirName: "0002_addPosts"');
    // headRef is inlined and pulls .to from the last package's metadata import.
    expect(out).toContain("hash: mig_0002_addPosts_meta.to");
    expect(out).toContain("invariants: (mig_0002_addPosts_meta.providedInvariants");
  });

  it("does not write migrations/refs/ (would collide with framework's space scanner)", async () => {
    await writePackage({ dirName: "0001_baseline", from: null, to: "sha256:A" });

    await generateContractSpace(defaultPaths(cwd));

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(cwd, "migrations", "refs"))).toBe(false);
  });

  it("throws on a broken chain", async () => {
    await writePackage({ dirName: "0001_v1", from: null, to: "sha256:A" });
    // Second package's `from` doesn't match first's `to`.
    await writePackage({ dirName: "0002_v2", from: "sha256:WRONG", to: "sha256:B" });

    await expect(generateContractSpace(defaultPaths(cwd))).rejects.toThrow(/chain broken/i);
  });

  it("is idempotent", async () => {
    await writePackage({ dirName: "0001_baseline", from: null, to: "sha256:A" });

    await generateContractSpace(defaultPaths(cwd));
    const first = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");

    await generateContractSpace(defaultPaths(cwd));
    const second = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");

    expect(first).toBe(second);
  });

  it("respects explicit migrationsDir/contractPath/outPath", async () => {
    const customMigDir = join(cwd, "custom-migs");
    const customContract = join(cwd, "custom-contract.json");
    const customOut = join(cwd, "out.ts");

    await mkdir(join(customMigDir, "app", "0001"), { recursive: true });
    await writeFile(customContract, JSON.stringify({ storage: { storageHash: "sha256:X" } }), "utf-8");
    await writeFile(
      join(customMigDir, "app", "0001", "migration.json"),
      JSON.stringify({
        from: null,
        to: "sha256:X",
        migrationHash: "sha256:h",
        providedInvariants: [],
        labels: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        hints: { used: [], applied: [], plannerVersion: "2.0.0" },
      }),
      "utf-8"
    );
    await writeFile(join(customMigDir, "app", "0001", "ops.json"), "[]", "utf-8");

    const exitCode = await generateContractSpace({
      migrationsDir: customMigDir,
      contractPath: customContract,
      outPath: customOut,
    });
    expect(exitCode).toBe(0);

    const out = await readFile(customOut, "utf-8");
    expect(out).toContain('dirName: "0001"');
  });
});
