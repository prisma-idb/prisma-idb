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

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import idbTarget from "@prisma-idb/target-idb/pack";
import { defineContract } from "../src/core/contract-builder";
import idbFamily from "../src/exports/pack";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import { runPreflight } from "../src/core/preflight";
import { migrationPlan } from "../src/core/migration-plan";

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

// Exercise the emitted migration entrypoint, including its self-emit CLI, with
// actual contract record shapes rather than hand-built DDL-only fixtures.
describe("migrationPlan — record shape round trips", () => {
  it.each(["baseline", "added store"])("preserves operations and migration hash for %s", async (mode) => {
    const user = { store: "users", key: "id", fields: { id: "String" as const } };
    if (mode === "added store") {
      await writeContract(cwd, defineContract({ family: idbFamily, target: idbTarget, models: { User: user } }));
      expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    }
    const contract = defineContract({
      family: idbFamily,
      target: idbTarget,
      models: {
        User: user,
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", title: "String?" },
          indexes: { byTitle: { keyPath: "title" } },
        },
      },
    });
    expect(contract.storage.stores["posts"]!.record).toBeDefined();
    await writeContract(cwd, contract);
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "create_posts" })).toBe(0);

    const dirName = (await listMigrationDirs(cwd)).find((dir) => dir.endsWith("_create_posts"))!;
    const originalOps = await readOps(cwd, dirName);
    const originalMeta = await readMeta(cwd, dirName);
    // Let the temporary project resolve the public target package used by
    // the generated file, just as an installed consumer project would.
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(cwd, "node_modules"), "dir");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
    try {
      await promisify(execFile)(process.execPath, [
        "--import",
        import.meta.resolve("tsx"),
        join(cwd, "migrations", "app", dirName, "migration.ts"),
      ]);
      expect(await readOps(cwd, dirName)).toEqual(originalOps);
      expect((await readMeta(cwd, dirName)).migrationHash).toBe(originalMeta.migrationHash);
      for (const op of originalOps) {
        if (op.kind === "createObjectStore") expect(op).not.toHaveProperty("def.record");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

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

describe("migrationPlan — record field changes", () => {
  function psl(fields: string) {
    const { document, sources } = parse(`model User {\n id String @id\n ${fields}\n @@map("users")\n}`, "test.prisma");
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
    const result = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
  }

  it("scaffolds missing backfills, rejects unfilled emit and preflight, and accepts a filled scaffold", async () => {
    await writeContract(cwd, psl(""));
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, psl("role String\n enabled Boolean"));
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "backfill" })).toBe(0);
    const dirName = (await listMigrationDirs(cwd)).find((dir) => dir.endsWith("_backfill"))!;
    const source = await readMigrationTs(cwd, dirName);
    expect(source).toContain('placeholder("User.role")');
    expect(source).toContain('placeholder("User.enabled")');
    const ops = await readOps(cwd, dirName);
    const metadata = await readMeta(cwd, dirName);
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(cwd, "node_modules"), "dir");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
    const migrationPath = join(cwd, "migrations", "app", dirName, "migration.ts");
    const emit = () => promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), migrationPath]);
    await expect(emit()).rejects.toMatchObject({
      stderr: expect.stringMatching(/MIGRATION\.UNFILLED_PLACEHOLDER(?=[\s\S]*User.role)(?=[\s\S]*User.enabled)/),
    });
    expect(await readOps(cwd, dirName)).toEqual(ops);
    expect(await readMeta(cwd, dirName)).toEqual(metadata);
    expect(await runPreflight({ migrationsDir: defaultPaths(cwd).migrationsDir })).toBe(1);
    expect(capturedStderr).toMatch(/MIGRATION\.UNFILLED_PLACEHOLDER(?=[\s\S]*User.role)(?=[\s\S]*User.enabled)/);
    const filled = source
      .replace(", placeholder,", ", defaultIfMissing,")
      .replace('placeholder("User.role")', 'defaultIfMissing("member")')
      .replace('placeholder("User.enabled")', "defaultIfMissing(false)");
    await writeFile(migrationPath, filled);
    await emit();
    expect(await readOps(cwd, dirName)).toEqual([
      expect.objectContaining({
        fields: {
          role: { kind: "defaultIfMissing", value: "member" },
          enabled: { kind: "defaultIfMissing", value: false },
        },
      }),
    ]);
    expect(await runPreflight({ migrationsDir: defaultPaths(cwd).migrationsDir })).toBe(0);
  });

  it("warns about field loss and self-emits identical record operations and hashes", async () => {
    await writeContract(cwd, psl("old String"));
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, psl('role String @default("member")'));
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "replace_field" })).toBe(0);
    const dirName = (await listMigrationDirs(cwd)).find((dir) => dir.endsWith("_replace_field"))!;
    const ops = await readOps(cwd, dirName);
    const metadata = await readMeta(cwd, dirName);
    expect(ops).toEqual([
      expect.objectContaining({
        kind: "transformRecords",
        removeFields: ["old"],
        fields: { role: { kind: "defaultIfMissing", value: "member" } },
      }),
    ]);
    expect(capturedStderr).toContain("Warning: this migration deletes data.");
    expect(capturedStderr).toContain("users.old");
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(cwd, "node_modules"), "dir");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
    await promisify(execFile)(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      join(cwd, "migrations", "app", dirName, "migration.ts"),
    ]);
    expect(await readOps(cwd, dirName)).toEqual(ops);
    expect(await readMeta(cwd, dirName)).toEqual(metadata);
  });

  it.each([0, -12.5, 123.45])("self-emits identical Decimal default operations and hashes for %j", async (value) => {
    await writeContract(cwd, psl(""));
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, psl(`amount Decimal @default(${value})`));
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "add_decimal" })).toBe(0);
    const dirName = (await listMigrationDirs(cwd)).find((dir) => dir.endsWith("_add_decimal"))!;
    const ops = await readOps(cwd, dirName);
    const metadata = await readMeta(cwd, dirName);
    expect(ops).toEqual([
      expect.objectContaining({
        kind: "transformRecords",
        fields: { amount: { kind: "defaultIfMissing", value: String(value) } },
      }),
    ]);
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(cwd, "node_modules"), "dir");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
    await promisify(execFile)(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      join(cwd, "migrations", "app", dirName, "migration.ts"),
    ]);
    expect(await readOps(cwd, dirName)).toEqual(ops);
    expect(await readMeta(cwd, dirName)).toEqual(metadata);
  });

  it("writes an explicit no-operation migration for an added nullable field", async () => {
    await writeContract(cwd, psl(""));
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);
    await writeContract(cwd, psl("role String?"));
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "optional_role" })).toBe(0);
    const dirName = (await listMigrationDirs(cwd)).find((dir) => dir.endsWith("_optional_role"))!;
    expect(await readOps(cwd, dirName)).toEqual([]);
    expect(await readMigrationTs(cwd, dirName)).toContain("No record or schema operations are needed");
    expect(capturedStderr).not.toContain("deletes data");
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

  it("warns on stderr when the migration drops a store, and not otherwise", async () => {
    await writeContract(cwd, CONTRACT_V2);
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);

    capturedStderr = "";
    await writeContract(cwd, {
      storage: { storageHash: "sha256:contractv3", stores: { outboxEvent: { keyPath: "id" } } },
    });
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "drop_version_meta" })).toBe(0);
    expect(capturedStderr).toMatch(/deletes data/);
    expect(capturedStderr).toContain("  - versionMeta\n");

    capturedStderr = "";
    await writeContract(cwd, {
      storage: {
        storageHash: "sha256:contractv4",
        stores: { ...CONTRACT_V2.storage.stores, auditLog: { keyPath: "id" } },
      },
    });
    expect(await migrationPlan({ ...defaultPaths(cwd), name: "readd_version_meta" })).toBe(0);
    expect(capturedStderr).not.toMatch(/deletes data/);
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
