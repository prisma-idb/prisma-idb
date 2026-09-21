/**
 * End-to-end smoke test for the prisma-idb CLI workflow.
 *
 * Mirrors the getting-started tutorial:
 *   1.  Write schema V1 (User model) and emit contract artifacts
 *   2.  migration plan (greenfield) → verify package layout + migration.json + ops.json + migration.ts
 *   3.  migration contract-space → verify generated TypeScript bundle
 *   4.  Modify schema to V2 (add Todo model) and re-emit contract artifacts
 *   5.  migration plan --name add_todo (incremental) → verify package with correct from/to
 *   6.  migration contract-space (again) → verify both packages in bundle
 *   7.  migration preflight → exit 0 (full chain applies cleanly against fake-indexeddb)
 *   8.  Deep assertions: chain integrity, file content, ORM type exports
 */

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import { idbEmission } from "../src/core/emission";
import { migrationPlan } from "../src/core/migration-plan";
import { generateContractSpace } from "../src/core/contract-space-codegen";
import { runPreflight } from "../src/core/preflight";
import { chainOrderByMetadata } from "../src/core/chain-order";

// ── Schema fixtures ──────────────────────────────────────────────────────────

// V1: single model, one unique index
const SCHEMA_V1 = `
  model User {
    id    String  @id
    name  String
    email String? @unique
  }
`;

// V2: adds Todo with a Cascade-delete FK relation to User
const SCHEMA_V2 = `
  model User {
    id    String  @id
    name  String
    email String? @unique
    todos Todo[]
  }

  model Todo {
    id     String  @id
    title  String
    done   Boolean
    userId String
    user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  }
`;

// ── Contract emission helper ─────────────────────────────────────────────────
//
// Simulates `prisma contract emit` without spawning a process:
//   1. Parse the PSL schema
//   2. Interpret it into an IDB contract object
//   3. Serialize to contract.json
//   4. Build a type-accurate contract.d.ts using the idbEmission SPI (the same
//      hooks the framework emitter calls)

interface ContractArtifacts {
  readonly contract: Contract;
  readonly contractJson: string;
  readonly contractDts: string;
  readonly storageHash: string;
}

function emitContract(schema: string, sourceId = "schema.prisma"): ContractArtifacts {
  const { document, sourceFile } = parse(schema);
  const { table } = buildSymbolTable({
    document,
    sourceFile,
    pslBlockDescriptors: {},
  });
  const result = interpretPslDocumentToIdbContract(table, sourceId);
  if (!result.ok) {
    throw new Error(
      `Contract interpretation failed:\n${result.failure.diagnostics.map((d) => `  [${d.code}] ${d.message}`).join("\n")}`
    );
  }
  const contract = result.value;
  const storageHash = contract.storage.storageHash;

  // Build a realistic contract.d.ts using the idbEmission SPI so the
  // snapshot-store contract.d.ts assertions can verify per-store type content.
  const storageType = idbEmission.generateStorageType(contract, "StorageHash");
  const familyImports = idbEmission.getFamilyImports().join("\n");
  const typeMapsExpr = idbEmission.getTypeMapsExpression();
  const contractWrapper = idbEmission.getContractWrapper("ContractBase", "TypeMaps");
  const familyTypeAliases = idbEmission.getFamilyTypeAliases();

  const contractDts = [
    "// THIS FILE IS AUTO-GENERATED — DO NOT EDIT",
    familyImports,
    "",
    `export type StorageHash = ${JSON.stringify(storageHash)};`,
    "",
    `type ContractBase = { readonly storage: ${storageType} };`,
    "",
    "export type CodecTypes = {};",
    "export type FieldOutputTypes = {};",
    "export type FieldInputTypes = {};",
    `export type TypeMaps = ${typeMapsExpr};`,
    "",
    contractWrapper,
    "",
    familyTypeAliases,
  ].join("\n");

  return {
    contract,
    contractJson: JSON.stringify(contract, null, 2),
    contractDts,
    storageHash,
  };
}

// ── Test harness ─────────────────────────────────────────────────────────────

let cwd: string;
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "idb-smoke-test-"));
  await mkdir(join(cwd, "src", "lib", "prisma"), { recursive: true });

  originalStdout = process.stdout.write.bind(process.stdout);
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

// ── Typed shapes for reading generated files ─────────────────────────────────

interface MigrationMeta {
  from: string | null;
  to: string;
  migrationHash: string;
  createdAt: string;
  providedInvariants: string[];
}

interface Op {
  kind: string;
  id: string;
  label: string;
  operationClass: string;
  storeName?: string;
  indexName?: string;
  def?: Record<string, unknown>;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

const contractJsonPath = (base: string) => join(base, "src", "lib", "prisma", "contract.json");
const contractDtsPath = (base: string) => join(base, "src", "lib", "prisma", "contract.d.ts");
const contractSpacePath = (base: string) => join(base, "src", "lib", "prisma", "contract-space.generated.ts");
const migrationsDir = (base: string) => join(base, "migrations");
const appDir = (base: string) => join(migrationsDir(base), "app");
const pkgPath = (base: string, dir: string) => join(appDir(base), dir);
const defaultPaths = (base: string) => ({ migrationsDir: migrationsDir(base), contractPath: contractJsonPath(base) });
const snapshotPath = (base: string, hash: string, file: string) => join(migrationsDir(base), "snapshots", hash, file);

async function listMigrationDirs(base: string): Promise<string[]> {
  const entries = await readdir(appDir(base), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function readMeta(base: string, dir: string): Promise<MigrationMeta> {
  return JSON.parse(await readFile(join(pkgPath(base, dir), "migration.json"), "utf-8")) as MigrationMeta;
}

async function readOps(base: string, dir: string): Promise<Op[]> {
  return JSON.parse(await readFile(join(pkgPath(base, dir), "ops.json"), "utf-8")) as Op[];
}

async function readText(base: string, dir: string, file: string): Promise<string> {
  return readFile(join(pkgPath(base, dir), file), "utf-8");
}

// ── The smoke test ───────────────────────────────────────────────────────────

describe("end-to-end workflow smoke test", () => {
  it("follows the getting-started tutorial from baseline through an incremental migration", async () => {
    // ── Step 1: Emit contract for schema V1 ──────────────────────────────────

    const v1 = emitContract(SCHEMA_V1);
    await writeFile(contractJsonPath(cwd), v1.contractJson, "utf-8");
    await writeFile(contractDtsPath(cwd), v1.contractDts, "utf-8");

    expect(v1.storageHash).toMatch(/^[0-9a-f]{64}$/);
    // V1 contract has the user store and no todo store
    expect(v1.contractDts).toContain("IdbContractWithTypeMaps");
    expect(v1.contractDts).toContain("export type Contract");
    expect(v1.contractDts).toContain("export type Stores");
    expect(v1.contractDts).toContain("readonly user:"); // store key in storage type literal
    expect(v1.contractDts).not.toContain("readonly todo:");

    // ── Step 2: migration plan (auto-detects greenfield/baseline) ────────────

    const baselineCode = await migrationPlan(defaultPaths(cwd));
    expect(baselineCode).toBe(0);

    const dirsAfterBaseline = await listMigrationDirs(cwd);
    expect(dirsAfterBaseline).toHaveLength(1);
    const baselineDir = dirsAfterBaseline[0]!;
    expect(baselineDir).toMatch(/^\d{8}T\d{4}_baseline$/);

    // migration.json: baseline sentinel
    const baselineMeta = await readMeta(cwd, baselineDir);
    expect(baselineMeta.from).toBeNull();
    expect(baselineMeta.to).toBe(v1.storageHash);
    expect(typeof baselineMeta.migrationHash).toBe("string");
    expect(baselineMeta.migrationHash.length).toBeGreaterThan(0);
    expect(() => new Date(baselineMeta.createdAt)).not.toThrow();

    // ops.json: marker store + user store + email_unique index
    const baselineOps = await readOps(cwd, baselineDir);
    expect(baselineOps.length).toBeGreaterThan(0);

    const markerOp = baselineOps.find(
      (op) => op.kind === "createObjectStore" && op.storeName === "_prisma_next_marker"
    );
    expect(markerOp).toBeDefined();
    expect(markerOp?.operationClass).toBe("additive");

    const userStoreOp = baselineOps.find((op) => op.kind === "createObjectStore" && op.storeName === "user");
    expect(userStoreOp).toBeDefined();
    expect(userStoreOp?.def).toMatchObject({ keyPath: "id" });

    const emailIndexOp = baselineOps.find(
      (op) => op.kind === "createIndex" && op.storeName === "user" && op.indexName === "email_unique"
    );
    expect(emailIndexOp).toBeDefined();
    expect(emailIndexOp?.def).toMatchObject({ keyPath: "email", unique: true });

    // All ops are additive (no destructive ops in a greenfield baseline)
    for (const op of baselineOps) {
      expect(op.operationClass).toBe("additive");
      expect(typeof op.id).toBe("string");
      expect(typeof op.label).toBe("string");
    }

    // migration.ts: class-based scaffold
    const baselineTs = await readText(cwd, baselineDir, "migration.ts");
    expect(baselineTs).toContain("class M extends Migration");
    expect(baselineTs).toContain("MigrationCLI.run(import.meta.url, M)");
    expect(baselineTs).toContain("from: null");
    expect(baselineTs).toContain(`to: "${v1.storageHash}"`);
    expect(baselineTs).toContain('"@prisma-idb/target-idb/migration"');
    expect(baselineTs).toContain('createObjectStoreOp("user"');

    // Package dir no longer carries its own contract copy (ADR 240)
    expect(existsSync(join(pkgPath(cwd, baselineDir), "end-contract.json"))).toBe(false);

    // snapshots/<hash>/contract.json: identical copy of the V1 contract.json
    const snapshotJson = await readFile(snapshotPath(cwd, v1.storageHash, "contract.json"), "utf-8");
    expect(snapshotJson).toBe(v1.contractJson);

    // snapshots/<hash>/contract.d.ts: copied from contract.d.ts (has Contract/Stores/IdbContractWithTypeMaps)
    expect(existsSync(snapshotPath(cwd, v1.storageHash, "contract.d.ts"))).toBe(true);
    const baselineSnapshotDts = await readFile(snapshotPath(cwd, v1.storageHash, "contract.d.ts"), "utf-8");
    expect(baselineSnapshotDts).toContain("IdbContractWithTypeMaps");
    expect(baselineSnapshotDts).toContain("export type Contract");
    expect(baselineSnapshotDts).toContain("export type Stores");
    expect(baselineSnapshotDts).toContain("readonly user:"); // V1: user store present
    expect(baselineSnapshotDts).not.toContain("readonly todo:"); // V1: no todo store yet

    // ── Step 3: generate-contract-space (V1) ────────────────────────────────

    const spaceCodeV1 = await generateContractSpace({ ...defaultPaths(cwd), outPath: contractSpacePath(cwd) });
    expect(spaceCodeV1).toBe(0);

    const spaceV1 = await readFile(contractSpacePath(cwd), "utf-8");
    expect(spaceV1).toContain("THIS FILE IS AUTO-GENERATED");
    expect(spaceV1).toContain("contractSpaceFromJson");
    expect(spaceV1).toContain("_baseline");
    // headRef points at baseline's to hash
    expect(spaceV1).toContain(`mig_${baselineDir.replace(/-/g, "_")}_meta.to`);

    // ── Step 4: Emit contract for schema V2 (add Todo model) ─────────────────

    const v2 = emitContract(SCHEMA_V2);
    await writeFile(contractJsonPath(cwd), v2.contractJson, "utf-8");
    await writeFile(contractDtsPath(cwd), v2.contractDts, "utf-8");

    expect(v2.storageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v2.storageHash).not.toBe(v1.storageHash); // schema changed → different hash
    // V2 contract has both user and todo stores
    expect(v2.contractDts).toContain("readonly user:");
    expect(v2.contractDts).toContain("readonly todo:");

    // ── Step 5: migration plan --name add_todo (incremental, head already exists) ──

    const migCode = await migrationPlan({ ...defaultPaths(cwd), name: "add_todo" });
    expect(migCode).toBe(0);

    const dirsAfterMigration = await listMigrationDirs(cwd);
    expect(dirsAfterMigration).toHaveLength(2);

    // The new package is the non-baseline one
    const migrationDir = dirsAfterMigration.find((d) => d !== baselineDir)!;
    expect(migrationDir).toBeDefined();
    expect(migrationDir).toMatch(/^\d{8}T\d{4}_add_todo$/);

    // migration.json: chain link from baseline's to → V2 storageHash
    const migrationMeta = await readMeta(cwd, migrationDir);
    expect(migrationMeta.from).toBe(v1.storageHash); // links from baseline's `to`
    expect(migrationMeta.to).toBe(v2.storageHash); // lands at new contract's hash
    expect(migrationMeta.from).not.toBeNull();
    expect(typeof migrationMeta.migrationHash).toBe("string");
    expect(migrationMeta.migrationHash.length).toBeGreaterThan(0);

    // ops.json: only the delta (todo store + userId index)
    const migrationOps = await readOps(cwd, migrationDir);
    expect(migrationOps.length).toBeGreaterThan(0);

    const todoStoreOp = migrationOps.find((op) => op.kind === "createObjectStore" && op.storeName === "todo");
    expect(todoStoreOp).toBeDefined();
    expect(todoStoreOp?.def).toMatchObject({ keyPath: "id" });
    expect(todoStoreOp?.operationClass).toBe("additive");

    const userIdIndexOp = migrationOps.find(
      (op) => op.kind === "createIndex" && op.storeName === "todo" && op.indexName === "userId"
    );
    expect(userIdIndexOp).toBeDefined();
    expect(userIdIndexOp?.operationClass).toBe("additive");

    // No ops touch the user store (it didn't change)
    const opsOnUser = migrationOps.filter((op) => op.storeName === "user");
    expect(opsOnUser).toHaveLength(0);

    // migration.ts: describes the hash transition, not a greenfield baseline
    const migrationTs = await readText(cwd, migrationDir, "migration.ts");
    expect(migrationTs).toContain("class M extends Migration");
    expect(migrationTs).toContain("MigrationCLI.run(import.meta.url, M)");
    expect(migrationTs).toContain(`from: "${v1.storageHash}"`); // NOT null
    expect(migrationTs).toContain(`to: "${v2.storageHash}"`);
    expect(migrationTs).toContain('createObjectStoreOp("todo"');
    expect(migrationTs).not.toContain("from: null");

    // Package dir no longer carries its own contract copy (ADR 240)
    expect(existsSync(join(pkgPath(cwd, migrationDir), "end-contract.json"))).toBe(false);

    // snapshots/<hash>/contract.json: is the V2 contract
    const migSnapshotJson = await readFile(snapshotPath(cwd, v2.storageHash, "contract.json"), "utf-8");
    expect(migSnapshotJson).toBe(v2.contractJson);
    // Parse and verify the todo store is in the V2 snapshot
    const migSnapshotContract = JSON.parse(migSnapshotJson) as {
      storage: { stores: Record<string, unknown>; storageHash: string };
    };
    expect(migSnapshotContract.storage.storageHash).toBe(v2.storageHash);
    expect(migSnapshotContract.storage.stores).toHaveProperty("user");
    expect(migSnapshotContract.storage.stores).toHaveProperty("todo");

    // The V1 snapshot from the baseline step is still present — the store
    // is additive, never overwritten by a later plan.
    expect(existsSync(snapshotPath(cwd, v1.storageHash, "contract.json"))).toBe(true);

    // snapshots/<hash>/contract.d.ts: V2 types — both stores present
    expect(existsSync(snapshotPath(cwd, v2.storageHash, "contract.d.ts"))).toBe(true);
    const migSnapshotDts = await readFile(snapshotPath(cwd, v2.storageHash, "contract.d.ts"), "utf-8");
    expect(migSnapshotDts).toContain("IdbContractWithTypeMaps");
    expect(migSnapshotDts).toContain("export type Contract");
    expect(migSnapshotDts).toContain("export type Stores");
    expect(migSnapshotDts).toContain("readonly user:");
    expect(migSnapshotDts).toContain("readonly todo:"); // V2: todo store is now present

    // ── Step 6: generate-contract-space (V2) ────────────────────────────────

    const spaceCodeV2 = await generateContractSpace({ ...defaultPaths(cwd), outPath: contractSpacePath(cwd) });
    expect(spaceCodeV2).toBe(0);

    const spaceV2 = await readFile(contractSpacePath(cwd), "utf-8");
    expect(spaceV2).toContain("_baseline");
    expect(spaceV2).toContain("_add_todo");
    // headRef now points at the migration's to hash (V2)
    const migDirKey = migrationDir.replace(/-/g, "_");
    expect(spaceV2).toContain(`mig_${migDirKey}_meta.to`);
    // The V1 baseline is still present
    const baseDirKey = baselineDir.replace(/-/g, "_");
    expect(spaceV2).toContain(`mig_${baseDirKey}_meta`);

    // ── Step 7: preflight ────────────────────────────────────────────────────

    const preflightCode = await runPreflight({ migrationsDir: migrationsDir(cwd) });
    expect(preflightCode).toBe(0);

    // ── Step 8: Chain integrity cross-checks ─────────────────────────────────

    // Load both packages' metadata and verify chainOrderByMetadata produces
    // the correct linear order (baseline → migration).
    const packages = new Map<string, { dirName: string; metadata: { from: string | null; to: string } }>();
    for (const dir of dirsAfterMigration) {
      const meta = await readMeta(cwd, dir);
      packages.set(dir, { dirName: dir, metadata: { from: meta.from, to: meta.to } });
    }
    const ordered = chainOrderByMetadata(packages);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]!.dirName).toBe(baselineDir);
    expect(ordered[1]!.dirName).toBe(migrationDir);
    // Chain is continuous: baseline.to === migration.from
    expect(ordered[0]!.metadata.to).toBe(ordered[1]!.metadata.from);
    // Endpoints match the contract hashes
    expect(ordered[0]!.metadata.from).toBeNull();
    expect(ordered[0]!.metadata.to).toBe(v1.storageHash);
    expect(ordered[1]!.metadata.to).toBe(v2.storageHash);
  }, 60_000); // 60s — full workflow including fake-indexeddb preflight

  it("refuses to generate the next migration when the head package is internally inconsistent", async () => {
    const v1 = emitContract(SCHEMA_V1);
    await writeFile(contractJsonPath(cwd), v1.contractJson, "utf-8");
    await writeFile(contractDtsPath(cwd), v1.contractDts, "utf-8");
    expect(await migrationPlan(defaultPaths(cwd))).toBe(0);

    const dirs = await listMigrationDirs(cwd);
    const baselineDir = dirs[0]!;
    const baselineMeta = await readMeta(cwd, baselineDir);
    await writeFile(
      join(pkgPath(cwd, baselineDir), "migration.json"),
      JSON.stringify({ ...baselineMeta, to: "sha256:wrong-head-hash" }, null, 2),
      "utf-8"
    );

    const v2 = emitContract(SCHEMA_V2);
    await writeFile(contractJsonPath(cwd), v2.contractJson, "utf-8");
    await writeFile(contractDtsPath(cwd), v2.contractDts, "utf-8");

    await expect(migrationPlan({ ...defaultPaths(cwd), name: "add_todo" })).resolves.toBe(1);
    await expect(listMigrationDirs(cwd)).resolves.toEqual([baselineDir]);
  });
});
