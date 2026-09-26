/**
 * Shared helpers for the prisma-idb CLI regression tests.
 *
 * - `cli(args, opts)` — spawn the built `prisma-idb` binary in a
 *   given cwd, return `{ stdout, stderr, exitCode }`. Never throws on
 *   non-zero exit; tests assert on the returned code.
 * - `writePackage({ cwd, dirName, from, to, ops })` — write a complete
 *   migration package (migration.json + ops.json) into
 *   `<cwd>/migrations/app/<dirName>/`.
 * - `writeContractJson(cwd, storageHash)` — write a minimal
 *   `src/lib/prisma/contract.json` with the given hash.
 * - `writeRawContractJson(cwd, contract)` — write an arbitrary object as
 *   `src/lib/prisma/contract.json`; used when commands need a full contract
 *   (e.g. `migration plan`, which calls the migration planner).
 * - `getMigrationDirs(cwd)` — return sorted directory names under
 *   `<cwd>/migrations/app/`.
 * - `writeMinimalIdbConfig(cwd, opts?)` — write a `prisma.config.ts`
 *   with minimal stub descriptors (no real family/target/adapter package
 *   imports needed — `@prisma/orm-framework config`'s `validateConfig` only checks
 *   shape) so the CLI's config-driven path resolution has something to
 *   load. `setupTmpProject` calls this with the defaults every test already
 *   assumes (`src/lib/prisma/contract.json`, `migrations/`) — override
 *   `contractOutput`/`migrationsDir`/`familyId` to test config-driven
 *   resolution itself.
 * - `setupTmpProject()` — mkdtemp + minimal directory scaffolding + a
 *   default `prisma.config.ts`; returns the project cwd.
 */

import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { execa } from "execa";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Absolute path to the built CLI binary in the family-idb workspace.
 * Tests must run AFTER `pnpm -F @prisma-idb/family-idb build`.
 */
export const CLI_BIN = resolve(__dirname, "../../../packages/prisma-orm/family-idb/dist/bin/prisma-idb.mjs");

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Forces human-readable output for any real invocation. The engine defaults
 * to `--format json` when stdout isn't a TTY (true for every `execa`-spawned
 * child here) — every test below asserts against human-readable prose, so
 * `--format human` is appended whenever a subcommand is present. The
 * zero-args case (`cli([])`, "print help") bypasses format detection
 * entirely and is already human-readable without it — appending the flag
 * there gets misparsed as an attempted (unknown) subcommand, since the
 * engine expects a command path in position 0 unless there are truly no
 * arguments at all.
 */
export async function cli(args: readonly string[], opts: { cwd: string }): Promise<CliResult> {
  const fullArgs = args.length === 0 ? args : [...args, "--format", "human"];
  const result = await execa("node", [CLI_BIN, ...fullArgs], {
    cwd: opts.cwd,
    reject: false,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

export interface MinimalIdbConfigOptions {
  /** Relative to `cwd`. Default: `"src/lib/prisma/contract.json"` (matches every fixture's default layout). */
  readonly contractOutput?: string;
  /** Relative to `cwd`. Default: `"migrations"`. */
  readonly migrationsDir?: string;
  /** Default: `"idb"`. Set to something else to exercise the family-mismatch guard. */
  readonly familyId?: string;
  /** Default: `"prisma.config.ts"`. */
  readonly fileName?: string;
}

/**
 * Writes a `prisma.config.ts` (the rc.4+ unified filename) with minimal stub
 * descriptors nested under `definePrismaConfig({ orm: {...} })` — enough to
 * satisfy `@prisma/orm-framework/config/config-validation`'s
 * `collectConfigIssues` structural checks (`kind`/`id`/`familyId`/`version`/
 * `create`, cross-matching `familyId`s — the same checker the old
 * `@prisma/orm-framework config`'s `validateConfig` was, moved packages) without
 * importing real `@prisma-idb/family-idb/control` etc. The CLI only
 * ever reads `config.contract.output` and `config.migrations.dir` from the
 * loaded `orm` section — `contract.source` is never invoked by these
 * commands (only `contract emit` calls it), so a dummy `load` is fine.
 */
export async function writeMinimalIdbConfig(cwd: string, opts: MinimalIdbConfigOptions = {}): Promise<void> {
  const familyId = opts.familyId ?? "idb";
  const contractOutput = opts.contractOutput ?? "src/lib/prisma/contract.json";
  const migrationsDir = opts.migrationsDir ?? "migrations";
  const fileName = opts.fileName ?? "prisma.config.ts";
  const id = JSON.stringify(familyId);
  // Inlines what `definePrismaConfig` does (`{ ...config, $prismaConfig: 1 }`,
  // confirmed against `@prisma/cli-engine`'s own implementation) rather than
  // importing it — these fixtures live in a bare `mkdtemp(tmpdir())` project
  // with no node_modules of its own, so an import from a real package would
  // never resolve.
  const source = `
const family = { kind: "family", id: ${id}, familyId: ${id}, version: "0.0.0", emission: {}, create: () => ({}) };
const target = { kind: "target", id: ${id}, familyId: ${id}, version: "0.0.0", targetId: ${id}, create: () => ({}) };
const adapter = { kind: "adapter", id: ${id}, familyId: ${id}, version: "0.0.0", targetId: ${id}, create: () => ({}) };

export default {
  $prismaConfig: 1,
  orm: {
    family,
    target,
    adapter,
    contract: {
      source: { load: async () => ({ ok: true, value: {} }) },
      output: ${JSON.stringify(contractOutput)},
    },
    migrations: { dir: ${JSON.stringify(migrationsDir)} },
  },
};
`;
  await writeFile(join(cwd, fileName), source, "utf-8");
}

export async function setupTmpProject(label: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `idb-cli-test-${label}-`));
  await mkdir(join(cwd, "migrations", "app"), { recursive: true });
  await mkdir(join(cwd, "src", "lib", "prisma"), { recursive: true });
  await writeMinimalIdbConfig(cwd);
  return cwd;
}

export async function writeContractJson(cwd: string, storageHash: string): Promise<void> {
  await writeFile(
    join(cwd, "src", "lib", "prisma", "contract.json"),
    JSON.stringify({ storage: { storageHash } }, null, 2),
    "utf-8"
  );
}

export async function writeRawContractJson(cwd: string, contract: unknown): Promise<void> {
  await writeFile(join(cwd, "src", "lib", "prisma", "contract.json"), JSON.stringify(contract, null, 2), "utf-8");
}

export async function getMigrationDirs(cwd: string): Promise<string[]> {
  const appDir = join(cwd, "migrations", "app");
  const entries = await readdir(appDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export interface PackageInput {
  readonly cwd: string;
  readonly dirName: string;
  readonly from: string | null;
  readonly to: string;
  readonly migrationHash?: string;
  readonly providedInvariants?: readonly string[];
  readonly ops: readonly unknown[];
}

export async function writePackage(p: PackageInput): Promise<void> {
  const dir = join(p.cwd, "migrations", "app", p.dirName);
  await mkdir(dir, { recursive: true });
  const baseMetadata = {
    from: p.from,
    to: p.to,
    providedInvariants: p.providedInvariants ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const migrationHash =
    p.migrationHash ?? computeMigrationHash(baseMetadata, p.ops as Parameters<typeof computeMigrationHash>[1]);

  await writeFile(
    join(dir, "migration.json"),
    JSON.stringify(
      {
        ...baseMetadata,
        migrationHash,
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(join(dir, "ops.json"), JSON.stringify(p.ops, null, 2), "utf-8");
}

// ── Canonical op fixtures (match the schema the runtime expects) ─────────────

export const createMarkerStoreOp = {
  kind: "createObjectStore",
  id: "object-store._prisma_next_marker.create",
  label: 'Create internal marker store "_prisma_next_marker"',
  operationClass: "additive",
  storeName: "_prisma_next_marker",
  def: { keyPath: "space" },
} as const;

export const createUsersStoreOp = {
  kind: "createObjectStore",
  id: "object-store.users.create",
  label: 'Create object store "users"',
  operationClass: "additive",
  storeName: "users",
  def: { keyPath: "id" },
} as const;

export const createPostsStoreOp = {
  kind: "createObjectStore",
  id: "object-store.posts.create",
  label: 'Create object store "posts"',
  operationClass: "additive",
  storeName: "posts",
  def: { keyPath: "id" },
} as const;

export const createCommentsStoreOp = {
  kind: "createObjectStore",
  id: "object-store.comments.create",
  label: 'Create object store "comments"',
  operationClass: "additive",
  storeName: "comments",
  def: { keyPath: "id" },
} as const;

export const createPostsByAuthorIdIndexOp = {
  kind: "createIndex",
  id: "index.posts.byAuthorId.create",
  label: 'Create index "byAuthorId" on "posts"',
  operationClass: "additive",
  storeName: "posts",
  indexName: "byAuthorId",
  def: { keyPath: "authorId", unique: false },
} as const;

/**
 * A genuinely-broken op: create an index on a store that was never created.
 * The apply path calls `tx.objectStore("does-not-exist")`, which throws
 * NotFoundError. (Dropping a non-existent store is NOT a failure, because
 * each DDL op skips itself when there's nothing to do.)
 */
export const indexOnMissingStoreOp = {
  kind: "createIndex",
  id: "index.does-not-exist.byThing.create",
  label: 'Create index "byThing" on "does-not-exist"',
  operationClass: "additive",
  storeName: "does-not-exist",
  indexName: "byThing",
  def: { keyPath: "thing", unique: false },
} as const;
