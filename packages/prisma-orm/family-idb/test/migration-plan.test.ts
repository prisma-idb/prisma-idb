/**
 * Tests for `prisma-idb migration plan` — the merged baseline/incremental
 * migration planner (replaces the old separate `generate-baseline` /
 * `generate-migration` commands).
 *
 * Coverage:
 * - Auto-detection: empty target dir → greenfield/baseline (with a stderr
 *   warning); non-empty target dir → incremental, requiring --name.
 * - Baseline-mode file layout, migration.json, ops.json, migration.ts,
 *   the shared contract-snapshot store (`migrations/snapshots/<hash>/`,
 *   ADR 240) — same assertions the old generate-baseline suite had,
 *   updated for the store layout.
 * - Incremental-mode chain linking, delta-only ops, head consistency checks
 *   — same assertions the old generate-migration suite had.
 * - spaceId (extension-space, ADR 212) behavior for both modes.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationPlan } from "../src/core/migration-plan";
import { generateContractSpace } from "../src/core/contract-space-codegen";

const MINIMAL_CONTRACT = {
  storage: {
    storageHash: "sha256:abc123testcontract",
    stores: {
      users: {
        keyPath: "id",
        indexes: {
          byEmail: { keyPath: "email", unique: true },
        },
      },
    },
  },
};

const MINIMAL_CONTRACT_JSON = JSON.stringify(MINIMAL_CONTRACT, null, 2);

const CONTRACT_V1 = {
  storage: {
    storageHash: "sha256:contractv1",
    stores: {
      outboxEvent: { keyPath: "id" },
    },
  },
};

const CONTRACT_V2 = {
  storage: {
    storageHash: "sha256:contractv2",
    stores: {
      outboxEvent: { keyPath: "id" },
      versionMeta: { keyPath: "id" },
    },
  },
};

let cwd: string;
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;
let capturedStderr: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "idb-migration-plan-test-"));
  await mkdir(join(cwd, "src", "lib", "prisma"), { recursive: true });
  await writeFile(join(cwd, "src", "lib", "prisma", "contract.json"), MINIMAL_CONTRACT_JSON, "utf-8");

  capturedStderr = "";
  originalStdout = process.stdout.write.bind(process.stdout);
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    capturedStderr += s;
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

function defaultPaths(base: string): { migrationsDir: string; contractPath: string } {
  return {
    migrationsDir: join(base, "migrations"),
    contractPath: join(base, "src", "lib", "prisma", "contract.json"),
  };
}

async function writeContract(base: string, contract: unknown): Promise<void> {
  await writeFile(join(base, "src", "lib", "prisma", "contract.json"), JSON.stringify(contract, null, 2), "utf-8");
}

// ── Auto-detection ───────────────────────────────────────────────────────────

describe("migrationPlan — auto-detection", () => {
  it("greenfield: empty migrations dir → baseline mode, default name, from: null", async () => {
    const code = await migrationPlan(defaultPaths(cwd));
    expect(code).toBe(0);

    const dirs = await listMigrationDirs(cwd);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^\d{8}T\d{4}_baseline$/);
    const meta = await readMeta(cwd, dirs[0]!);
    expect(meta.from).toBeNull();
  });

  it("greenfield: prints a warning that it's generating a full baseline", async () => {
    await migrationPlan(defaultPaths(cwd));
    expect(capturedStderr).toContain("no existing migrations found");
    expect(capturedStderr).toContain("generating a full baseline");
  });

  it("greenfield: does not require --name", async () => {
    const code = await migrationPlan(defaultPaths(cwd));
    expect(code).toBe(0);
  });

  it("incremental: non-empty migrations dir → requires --name, exits 2 if omitted", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0); // seed a baseline
    await writeContract(cwd, CONTRACT_V2);

    const code = await migrationPlan(defaultPaths(cwd));
    expect(code).toBe(2);
    expect(capturedStderr).toContain("--name <slug> is required");
  });

  it("incremental: with --name, diffs from the existing head instead of regenerating a baseline", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, CONTRACT_V2);

    const code = await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" });
    expect(code).toBe(0);

    const dirs = await listMigrationDirs(cwd);
    expect(dirs).toHaveLength(2);
    const newDir = dirs.find((d) => d.endsWith("_add_version_meta"))!;
    const meta = await readMeta(cwd, newDir);
    expect(meta.from).not.toBeNull();
  });
});

// ── Baseline-mode file layout (mirrors the old generate-baseline suite) ──────

describe("migrationPlan — baseline mode", () => {
  it("creates all three package files, plus a snapshot store entry keyed by the contract hash", async () => {
    await migrationPlan(defaultPaths(cwd));

    const pkgDir = await findOnlyPackageDir(cwd);
    expect(existsSync(join(pkgDir, "ops.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "migration.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "migration.ts"))).toBe(true);
    expect(existsSync(join(pkgDir, "end-contract.json"))).toBe(false);
    expect(existsSync(snapshotDir(cwd, MINIMAL_CONTRACT.storage.storageHash))).toBe(true);
  });

  it("copies contract.d.ts into the snapshot store when it exists alongside contract.json", async () => {
    const contractDtsPath = join(cwd, "src", "lib", "prisma", "contract.d.ts");
    await writeFile(contractDtsPath, "// generated contract types\nexport type StorageHash = string;\n", "utf-8");

    await migrationPlan(defaultPaths(cwd));

    const entryDtsPath = join(snapshotDir(cwd, MINIMAL_CONTRACT.storage.storageHash), "contract.d.ts");
    expect(existsSync(entryDtsPath)).toBe(true);
    const content = await readFile(entryDtsPath, "utf-8");
    expect(content).toContain("generated contract types");
  });

  it("emits a warning but still succeeds when contract.d.ts is absent", async () => {
    const code = await migrationPlan(defaultPaths(cwd));
    expect(code).toBe(0);
    expect(capturedStderr).toContain("contract.d.ts not found");

    const entryDir = snapshotDir(cwd, MINIMAL_CONTRACT.storage.storageHash);
    expect(existsSync(join(entryDir, "contract.d.ts"))).toBe(false);
    expect(existsSync(join(entryDir, "contract.json"))).toBe(true);
  });

  it("uses a custom name slug when provided", async () => {
    await migrationPlan({ ...defaultPaths(cwd), name: "init" });

    const dirs = await listMigrationDirs(cwd);
    expect(dirs[0]).toMatch(/^\d{8}T\d{4}_init$/);
  });

  it("migration.json: from null, to storageHash, non-empty migrationHash, ISO createdAt", async () => {
    await migrationPlan(defaultPaths(cwd));
    const meta = await readMeta(cwd, (await listMigrationDirs(cwd))[0]!);
    expect(meta.from).toBeNull();
    expect(meta.to).toBe(MINIMAL_CONTRACT.storage.storageHash);
    expect(typeof meta.migrationHash).toBe("string");
    expect(meta.migrationHash.length).toBeGreaterThan(0);
    expect(() => new Date(meta.createdAt)).not.toThrow();
  });

  it("ops.json: marker store, per-model stores, per-index ops, valid op shape", async () => {
    await migrationPlan(defaultPaths(cwd));
    const ops = await readOps(cwd, (await listMigrationDirs(cwd))[0]!);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.find((op) => op.kind === "createObjectStore" && op.storeName === "_prisma_next_marker")).toBeDefined();
    expect(ops.find((op) => op.kind === "createObjectStore" && op.storeName === "users")).toBeDefined();
    const indexOp = ops.find(
      (op) => op.kind === "createIndex" && op.storeName === "users" && op.indexName === "byEmail"
    );
    expect(indexOp?.def).toMatchObject({ unique: true });
    for (const op of ops) {
      expect(typeof op.id).toBe("string");
      expect(typeof op.label).toBe("string");
      expect(["additive", "widening", "destructive", "data"]).toContain(op.operationClass);
    }
  });

  it("migration.ts: class-based scaffold, from: null, imports, per-store op calls", async () => {
    await migrationPlan(defaultPaths(cwd));
    const ts = await readMigrationTs(cwd, (await listMigrationDirs(cwd))[0]!);
    expect(ts).toContain("class M extends Migration");
    expect(ts).toContain("MigrationCLI.run(import.meta.url, M)");
    expect(ts).toContain("from: null");
    expect(ts).toContain('"@prisma-idb/target-idb/migration"');
    expect(ts).toContain('createObjectStoreOp("users"');
  });

  it("the snapshot store's contract.json is identical to the source contract.json bytes", async () => {
    await migrationPlan(defaultPaths(cwd));
    const stored = await readFile(
      join(snapshotDir(cwd, MINIMAL_CONTRACT.storage.storageHash), "contract.json"),
      "utf-8"
    );
    expect(stored).toBe(MINIMAL_CONTRACT_JSON);
  });

  it("returns 1 when contract.json is missing", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(cwd, "src", "lib", "prisma", "contract.json"));

    const code = await migrationPlan(defaultPaths(cwd));
    expect(code).toBe(1);
    expect(capturedStderr).toContain("contract.json not found");
    expect(capturedStderr).toContain("contract emit");
  });

  it("uses custom contractPath/migrationsDir when provided", async () => {
    const customPath = join(cwd, "custom-contract.json");
    await writeFile(customPath, MINIMAL_CONTRACT_JSON, "utf-8");
    const customMigsDir = join(cwd, "db-migrations");

    const code = await migrationPlan({ contractPath: customPath, migrationsDir: customMigsDir });
    expect(code).toBe(0);

    const entries = await readdir(join(customMigsDir, "app"), { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory())).toHaveLength(1);
  });
});

// ── Incremental-mode (mirrors the old generate-migration suite) ─────────────

describe("migrationPlan — incremental mode", () => {
  beforeEach(async () => {
    await writeContract(cwd, CONTRACT_V1);
  });

  it("chains from the head package's `to`, lands at the new contract hash", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, CONTRACT_V2);

    expect(await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" })).toBe(0);
    const dirs = await listMigrationDirs(cwd);
    const newDir = dirs.find((d) => d.endsWith("_add_version_meta"))!;
    const meta = await readMeta(cwd, newDir);
    expect(meta.from).toBe(CONTRACT_V1.storage.storageHash);
    expect(meta.to).toBe(CONTRACT_V2.storage.storageHash);
  });

  it("ops only cover the delta, not the whole contract", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, CONTRACT_V2);
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" })).toBe(0);

    const dirs = await listMigrationDirs(cwd);
    const newDir = dirs.find((d) => d.endsWith("_add_version_meta"))!;
    const ops = await readOps(cwd, newDir);
    expect(ops.some((op) => op.kind === "createObjectStore" && op.storeName === "versionMeta")).toBe(true);
    expect(ops.some((op) => op.storeName === "outboxEvent")).toBe(false);
    expect(ops.some((op) => op.storeName === "_prisma_next_marker")).toBe(false);
  });

  it("returns 0 and does nothing when the contract is unchanged since the last migration", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    // Contract unchanged (still V1).
    const code = await migrationPlan({ ...defaultPaths(cwd), name: "noop" });
    expect(code).toBe(0);
    expect(await listMigrationDirs(cwd)).toHaveLength(1);
  });

  it("returns 1 when the head's snapshot store entry is missing", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await rm(snapshotDir(cwd, CONTRACT_V1.storage.storageHash), { recursive: true, force: true });

    await writeContract(cwd, CONTRACT_V2);
    const code = await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" });
    expect(code).toBe(1);
    expect(capturedStderr).toContain("inconsistent");
    expect(capturedStderr).toContain("no store entry exists");
  });

  it("returns 1 when the head package is internally inconsistent", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    const dirs = await listMigrationDirs(cwd);
    const metaPath = join(cwd, "migrations", "app", dirs[0]!, "migration.json");
    const meta = JSON.parse(await readFile(metaPath, "utf-8")) as Record<string, unknown>;
    await writeFile(metaPath, JSON.stringify({ ...meta, to: "sha256:wrong-head-hash" }, null, 2), "utf-8");

    await writeContract(cwd, CONTRACT_V2);
    const code = await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" });
    expect(code).toBe(1);
    expect(capturedStderr).toContain("inconsistent");
  });

  it("returns 1 when the head package's migration.json is unreadable", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    const dirs = await listMigrationDirs(cwd);
    const metaPath = join(cwd, "migrations", "app", dirs[0]!, "migration.json");
    await rm(metaPath);

    await writeContract(cwd, CONTRACT_V2);
    const code = await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" });
    expect(code).toBe(1);
    expect(capturedStderr).toContain(metaPath);
  });

  it("returns 1 when the head package's migration.json is malformed JSON", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    const dirs = await listMigrationDirs(cwd);
    const metaPath = join(cwd, "migrations", "app", dirs[0]!, "migration.json");
    await writeFile(metaPath, "{not valid json", "utf-8");

    await writeContract(cwd, CONTRACT_V2);
    const code = await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta" });
    expect(code).toBe(1);
    expect(capturedStderr).toContain(metaPath);
  });
});

// ── spaceId (extension-space mode, ADR 212) ──────────────────────────────────

describe("migrationPlan — spaceId (extension-space mode)", () => {
  it("baseline: writes the package directly under migrationsDir, not migrations/app/", async () => {
    const code = await migrationPlan({ ...defaultPaths(cwd), spaceId: "idb-sync" });
    expect(code).toBe(0);

    const entries = await readdir(join(cwd, "migrations"), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && e.name !== "refs" && e.name !== "snapshots");
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(cwd, "migrations", "app"))).toBe(false);
  });

  it("baseline: does not include a _prisma_next_marker createObjectStore op", async () => {
    await migrationPlan({ ...defaultPaths(cwd), spaceId: "idb-sync" });
    const ops = await readExtensionOps(cwd);
    expect(ops.find((op) => op.kind === "createObjectStore" && op.storeName === "_prisma_next_marker")).toBeUndefined();
  });

  it("baseline: pins migrations/refs/head.json with the contract's storageHash", async () => {
    await migrationPlan({ ...defaultPaths(cwd), spaceId: "idb-sync" });
    const headRef = JSON.parse(await readFile(join(cwd, "migrations", "refs", "head.json"), "utf-8")) as {
      hash: string;
      invariants: string[];
    };
    expect(headRef.hash).toBe(MINIMAL_CONTRACT.storage.storageHash);
    expect(Array.isArray(headRef.invariants)).toBe(true);
  });

  it("app-space mode does not write refs/head.json", async () => {
    await migrationPlan(defaultPaths(cwd));
    expect(existsSync(join(cwd, "migrations", "refs", "head.json"))).toBe(false);
  });

  it("incremental: updates migrations/refs/head.json to the new head", async () => {
    await writeContract(cwd, CONTRACT_V1);
    expect(await migrationPlan({ ...defaultPaths(cwd), spaceId: "idb-sync" })).toBe(0);
    await writeContract(cwd, CONTRACT_V2);
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta", spaceId: "idb-sync" })).toBe(0);

    const headRef = JSON.parse(await readFile(join(cwd, "migrations", "refs", "head.json"), "utf-8")) as {
      hash: string;
    };
    expect(headRef.hash).toBe(CONTRACT_V2.storage.storageHash);
  });

  it("app-space and extension-space baselines can coexist under the same migrationsDir", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    expect(await migrationPlan({ ...defaultPaths(cwd), spaceId: "idb-sync" })).toBe(0);

    const appEntries = await readdir(join(cwd, "migrations", "app"), { withFileTypes: true });
    expect(appEntries.filter((e) => e.isDirectory())).toHaveLength(1);

    const rootEntries = await readdir(join(cwd, "migrations"), { withFileTypes: true });
    const extDirs = rootEntries.filter(
      (e) => e.isDirectory() && e.name !== "app" && e.name !== "refs" && e.name !== "snapshots"
    );
    expect(extDirs).toHaveLength(1);
  });

  it('rejects spaceId "snapshots" — reserved for the contract-snapshot store', async () => {
    const code = await migrationPlan({ ...defaultPaths(cwd), spaceId: "snapshots" });
    expect(code).toBe(1);
    expect(capturedStderr).toContain("reserved");
  });

  it("a second incremental plan for an extension space doesn't mistake the store for a migration package", async () => {
    await writeContract(cwd, CONTRACT_V1);
    expect(await migrationPlan({ ...defaultPaths(cwd), spaceId: "idb-sync" })).toBe(0);
    await writeContract(cwd, CONTRACT_V2);
    const code = await migrationPlan({ ...defaultPaths(cwd), name: "add_version_meta", spaceId: "idb-sync" });
    expect(code).toBe(0);

    const rootEntries = await readdir(join(cwd, "migrations"), { withFileTypes: true });
    const extDirs = rootEntries.filter((e) => e.isDirectory() && e.name !== "refs" && e.name !== "snapshots");
    expect(extDirs).toHaveLength(2);
  });
});

// ── Integration: migrationPlan → generateContractSpace ───────────────────────

describe("migrationPlan → generateContractSpace integration", () => {
  it("the package produced by a greenfield plan is consumable by generateContractSpace", async () => {
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);

    const outPath = join(cwd, "src", "lib", "prisma", "contract-space.generated.ts");
    const spaceCode = await generateContractSpace({ ...defaultPaths(cwd), outPath });
    expect(spaceCode).toBe(0);

    const generated = await readFile(outPath, "utf-8");
    expect(generated).toContain("_baseline");
    expect(generated).toContain("contractSpaceFromJson");
    expect(generated).toContain("_meta.to");
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ParsedMetadata {
  from: string | null;
  to: string;
  migrationHash: string;
  createdAt: string;
  providedInvariants: string[];
}

interface ParsedOp {
  kind: string;
  storeName?: string;
  indexName?: string;
  def?: Record<string, unknown>;
  id: string;
  label: string;
  operationClass: string;
}

async function listMigrationDirs(base: string): Promise<string[]> {
  const appDir = join(base, "migrations", "app");
  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function findOnlyPackageDir(base: string): Promise<string> {
  const dirs = await listMigrationDirs(base);
  if (dirs.length !== 1) throw new Error(`Expected exactly 1 package dir, got ${dirs.length}`);
  return join(base, "migrations", "app", dirs[0]!);
}

function snapshotDir(base: string, hash: string): string {
  return join(base, "migrations", "snapshots", hash);
}

async function readMeta(base: string, dirName: string): Promise<ParsedMetadata> {
  return JSON.parse(
    await readFile(join(base, "migrations", "app", dirName, "migration.json"), "utf-8")
  ) as ParsedMetadata;
}

async function readOps(base: string, dirName: string): Promise<ParsedOp[]> {
  return JSON.parse(await readFile(join(base, "migrations", "app", dirName, "ops.json"), "utf-8")) as ParsedOp[];
}

async function readMigrationTs(base: string, dirName: string): Promise<string> {
  return readFile(join(base, "migrations", "app", dirName, "migration.ts"), "utf-8");
}

/** Like {@link readOps} but for extension-space mode (package dir sits directly under migrations/). */
async function readExtensionOps(base: string): Promise<ParsedOp[]> {
  const migrationsDir = join(base, "migrations");
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== "refs" && e.name !== "snapshots");
  if (dirs.length !== 1) throw new Error(`Expected exactly 1 package dir, got ${dirs.length}`);
  return JSON.parse(await readFile(join(migrationsDir, dirs[0]!.name, "ops.json"), "utf-8")) as ParsedOp[];
}
