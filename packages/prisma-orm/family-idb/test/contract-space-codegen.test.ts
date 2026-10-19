/**
 * Imports generated contract spaces to catch unresolved paths, swapped artifacts,
 * incorrect chain order and a head that points at the wrong migration.
 * Output placement, broken chains and idempotence remain separate regressions.
 */

import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContractSpace } from "@prisma/orm-framework/components/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { generateContractSpace } from "../src/core/contract-space-codegen";

let cwd: string;
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

  await symlink(resolve("node_modules"), join(cwd, "node_modules"), "dir");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Compiles and imports the emitted module using Node, including its real JSON dependencies. */
async function importGenerated(outPath: string): Promise<ContractSpace> {
  const source = await readFile(outPath, "utf-8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
    fileName: outPath,
  });
  expect(diagnostics).toEqual([]);
  const modulePath = outPath.replace(/\.ts$/, ".mjs");
  await writeFile(modulePath, outputText);
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `const {contractSpace} = await import(${JSON.stringify(pathToFileURL(modulePath).href)}); console.log(JSON.stringify(contractSpace));`,
  ]);
  return JSON.parse(stdout) as ContractSpace;
}

/** Resolves fixture paths and keeps CLI output out of test logs. */
function defaultPaths(base: string) {
  return {
    out: (_line: string) => {},
    err: (_line: string) => {},
    migrationsDir: join(base, "migrations"),
    contractPath: join(base, "src", "lib", "prisma", "contract.json"),
    outPath: join(base, "src", "lib", "prisma", "contract-space.generated.ts"),
  };
}

/** Writes a distinct migration package so swapped JSON imports are observable. */
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
  await writeFile(
    join(dir, "ops.json"),
    JSON.stringify([{ kind: "createObjectStore", storeName: opts.dirName }]),
    "utf-8"
  );
}

describe("generateContractSpace", () => {
  it("emits an empty-migrations module when no packages exist", async () => {
    const exitCode = await generateContractSpace(defaultPaths(cwd));
    expect(exitCode).toBe(0);

    const output = await importGenerated(defaultPaths(cwd).outPath);
    expect(output.contractJson.storage.storageHash).toBe("sha256:contract-x");
    expect(output.migrations).toEqual([]);
    expect(output.headRef).toEqual({ hash: "", invariants: [] });
  });

  it("imports migration metadata and operations in chain order and derives the final head", async () => {
    await writePackage({ dirName: "z_baseline", from: null, to: "sha256:A", invariants: ["inv-1"] });
    await writePackage({ dirName: "a_addPosts", from: "sha256:A", to: "sha256:B", invariants: ["head-invariant"] });

    const exitCode = await generateContractSpace(defaultPaths(cwd));
    expect(exitCode).toBe(0);

    const output = await importGenerated(defaultPaths(cwd).outPath);
    expect(
      output.migrations.map((pkg) => ({
        dirName: pkg.dirName,
        from: pkg.metadata.from,
        to: pkg.metadata.to,
        ops: pkg.ops,
      }))
    ).toEqual([
      {
        dirName: "z_baseline",
        from: null,
        to: "sha256:A",
        ops: [{ kind: "createObjectStore", storeName: "z_baseline" }],
      },
      {
        dirName: "a_addPosts",
        from: "sha256:A",
        to: "sha256:B",
        ops: [{ kind: "createObjectStore", storeName: "a_addPosts" }],
      },
    ]);
    expect(output.headRef).toEqual({ hash: "sha256:B", invariants: ["head-invariant"] });
  });

  it("does not write migrations/refs/ (would collide with framework's space scanner)", async () => {
    await writePackage({ dirName: "z_baseline", from: null, to: "sha256:A" });

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
    await writePackage({ dirName: "z_baseline", from: null, to: "sha256:A" });

    await generateContractSpace(defaultPaths(cwd));
    const first = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");

    await generateContractSpace(defaultPaths(cwd));
    const second = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");

    expect(first).toBe(second);
  });

  it("orders migrations by from/to chain, not by directory name", async () => {
    // Regression: a lexicographic sort put `T0337_addcomments` before `T120000_baseline`.
    await writePackage({ dirName: "20260527T0337_addcomments", from: "sha256:A", to: "sha256:B" });
    await writePackage({ dirName: "20260527T120000_baseline", from: null, to: "sha256:A" });

    expect(await generateContractSpace(defaultPaths(cwd))).toBe(0);

    const out = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
    expect(out.indexOf('dirName: "20260527T120000_baseline"')).toBeGreaterThan(-1);
    expect(out.indexOf('dirName: "20260527T120000_baseline"')).toBeLessThan(
      out.indexOf('dirName: "20260527T0337_addcomments"')
    );
    expect(out).toContain("hash: mig_20260527T0337_addcomments_meta.to");
  });

  it("treats a missing migrations/app directory as no migrations", async () => {
    // Early bootstrap: the contract is emitted but `migration plan` has not run yet.
    await rm(join(cwd, "migrations", "app"), { recursive: true });

    expect(await generateContractSpace(defaultPaths(cwd))).toBe(0);

    const out = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
    expect(out).toContain("migrations: [],");
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
      ...defaultPaths(cwd),
      migrationsDir: customMigDir,
      contractPath: customContract,
      outPath: customOut,
    });
    expect(exitCode).toBe(0);

    const output = await importGenerated(customOut);
    expect(output.migrations.map((pkg) => pkg.dirName)).toEqual(["0001"]);
    expect(output.contractJson.storage.storageHash).toBe("sha256:X");
    expect(output.headRef.hash).toBe("sha256:X");
  });
});
