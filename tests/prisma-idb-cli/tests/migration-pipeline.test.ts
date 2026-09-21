/**
 * End-to-end regression tests for the full prisma-idb migration pipeline.
 *
 * Each test drives the CLI commands in the order a developer would run them on
 * a real project, using a temp directory and real contract JSON fixtures
 * derived from `apps/prisma-orm-usage`:
 *
 *   Phase 1 (baseline):
 *     prisma-idb migration plan
 *     prisma-idb migration contract-space
 *     prisma-idb migration preflight
 *
 *   Phase 2 (add posts):
 *     (write second migration package — simulating a real `migration plan`
 *     incremental run)
 *     prisma-idb migration contract-space
 *     prisma-idb migration preflight
 *
 * The contract fixtures are the exact JSON snapshots produced by
 * `prisma contract emit` for the corresponding schema states.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cli,
  createPostsByAuthorIdIndexOp,
  createPostsStoreOp,
  getMigrationDirs,
  setupTmpProject,
  writePackage,
  writeRawContractJson,
} from "./_helpers";

// ── Contract fixtures ────────────────────────────────────────────────────────
// Exact JSON snapshots from apps/prisma-orm-usage: the "no-posts" state
// (end-contract.json from the baseline migration) and the "with-posts" state
// (the current contract.json). Using real hashes keeps the chain unambiguous.

const V1_STORAGE_HASH = "sha256:46a587fce453e2298b888ce5307312ac010fafb203b9f0ab188eb4fb6be17bc0";
const V2_STORAGE_HASH = "sha256:b05717321fba711de059ca6e508f0f2087f2eaca7de74beb8f969ac5f0c606d9";

const CONTRACT_V1_NO_POSTS = {
  schemaVersion: "1",
  targetFamily: "idb",
  target: "idb",
  profileHash: "sha256:e97a15c6c5e8cd6446e4f48dc464af667a10a0a4ecb533c9624bbab58233a14d",
  roots: {
    random_store: { model: "RandomStore", namespace: "__unbound__" },
    users: { model: "User", namespace: "__unbound__" },
  },
  domain: {
    namespaces: {
      __unbound__: {
        models: {
          RandomStore: {
            fields: { id: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } } },
            relations: {},
            storage: { keyPath: "id", storeName: "random_store" },
          },
          User: {
            fields: {
              active: { nullable: false, type: { codecId: "idb/bool@1", kind: "scalar" } },
              bio: { nullable: true, type: { codecId: "idb/string@1", kind: "scalar" } },
              email: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } },
              id: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } },
              joinedAt: { nullable: false, type: { codecId: "idb/date@1", kind: "scalar" } },
              name: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } },
              score: { nullable: false, type: { codecId: "idb/int32@1", kind: "scalar" } },
            },
            relations: {},
            storage: { keyPath: "id", storeName: "users" },
          },
        },
      },
    },
  },
  storage: {
    namespaces: { __unbound__: { id: "__unbound__" } },
    storageHash: V1_STORAGE_HASH,
    stores: {
      random_store: { keyPath: "id" },
      users: {
        indexes: {
          byEmail: { keyPath: "email", unique: true },
          byScore: { keyPath: "score" },
        },
        keyPath: "id",
      },
    },
  },
  capabilities: { idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } },
  extensionPacks: {},
  meta: {},
};

const CONTRACT_V2_WITH_POSTS = {
  ...CONTRACT_V1_NO_POSTS,
  profileHash: "sha256:e97a15c6c5e8cd6446e4f48dc464af667a10a0a4ecb533c9624bbab58233a14d",
  roots: {
    ...CONTRACT_V1_NO_POSTS.roots,
    posts: { model: "Post", namespace: "__unbound__" },
  },
  domain: {
    namespaces: {
      __unbound__: {
        models: {
          ...CONTRACT_V1_NO_POSTS.domain.namespaces.__unbound__.models,
          Post: {
            fields: {
              authorId: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } },
              content: { nullable: true, type: { codecId: "idb/string@1", kind: "scalar" } },
              createdAt: { nullable: false, type: { codecId: "idb/date@1", kind: "scalar" } },
              id: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } },
              published: { nullable: false, type: { codecId: "idb/bool@1", kind: "scalar" } },
              title: { nullable: false, type: { codecId: "idb/string@1", kind: "scalar" } },
              views: { nullable: false, type: { codecId: "idb/int32@1", kind: "scalar" } },
            },
            relations: {},
            storage: { keyPath: "id", storeName: "posts" },
          },
        },
      },
    },
  },
  storage: {
    namespaces: { __unbound__: { id: "__unbound__" } },
    storageHash: V2_STORAGE_HASH,
    stores: {
      ...CONTRACT_V1_NO_POSTS.storage.stores,
      posts: {
        indexes: { byAuthorId: { keyPath: "authorId", unique: false } },
        keyPath: "id",
      },
    },
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("migration pipeline e2e", () => {
  it("migration plan (greenfield) creates a valid baseline package from a full contract", async () => {
    const cwd = await setupTmpProject("e2e-baseline-only");
    await writeRawContractJson(cwd, CONTRACT_V1_NO_POSTS);

    const { stderr, exitCode } = await cli(["migration", "plan"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Generated baseline migration");
    expect(stderr).toContain("from: null");
    expect(stderr).toContain(V1_STORAGE_HASH);

    const dirs = await getMigrationDirs(cwd);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/_baseline$/);

    const meta = JSON.parse(await readFile(join(cwd, "migrations", "app", dirs[0], "migration.json"), "utf-8")) as {
      from: null;
      to: string;
      migrationHash: string;
    };
    expect(meta.from).toBeNull();
    expect(meta.to).toBe(V1_STORAGE_HASH);
    // Bare hex, no `sha256:` prefix (rc.4+ hash convention).
    expect(meta.migrationHash).toMatch(/^[0-9a-f]{64,}$/);

    const ops = JSON.parse(await readFile(join(cwd, "migrations", "app", dirs[0], "ops.json"), "utf-8")) as Array<{
      kind: string;
      storeName: string;
    }>;
    const storeNames = ops.filter((op) => op.kind === "createObjectStore").map((op) => op.storeName);
    expect(storeNames).toContain("_prisma_next_marker");
    expect(storeNames).toContain("users");
    expect(storeNames).toContain("random_store");
    expect(storeNames).not.toContain("posts");
  });

  it("full pipeline: plan → contract-space → preflight, then add-posts → contract-space → preflight", async () => {
    const cwd = await setupTmpProject("e2e-full-pipeline");
    await writeRawContractJson(cwd, CONTRACT_V1_NO_POSTS);

    // ── Phase 1: generate the baseline ──────────────────────────────────────

    const r1 = await cli(["migration", "plan"], { cwd });
    expect(r1.exitCode).toBe(0);

    const dirs1 = await getMigrationDirs(cwd);
    expect(dirs1).toHaveLength(1);
    const baselineMeta = JSON.parse(
      await readFile(join(cwd, "migrations", "app", dirs1[0], "migration.json"), "utf-8")
    ) as { from: null; to: string };
    expect(baselineMeta.to).toBe(V1_STORAGE_HASH);

    const r2 = await cli(["migration", "contract-space"], { cwd });
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).toContain("1 migration");

    const generated1 = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
    expect(generated1).toContain(dirs1[0]);
    expect(generated1).not.toContain("posts");

    const r3 = await cli(["migration", "preflight"], { cwd });
    expect(r3.exitCode).toBe(0);
    expect(r3.stderr).toContain("Preflighting 1 migration(s)");
    expect(r3.stderr).toContain(dirs1[0] + " … ok");
    expect(r3.stderr).toContain("Preflight passed");

    // ── Phase 2: add the posts model ─────────────────────────────────────────
    // Simulates what `prisma-idb migration plan` would produce after the
    // developer adds the Post model to the schema and re-emits the contract.

    await writeRawContractJson(cwd, CONTRACT_V2_WITH_POSTS);
    await writePackage({
      cwd,
      dirName: "20260604T1029_add_posts",
      from: V1_STORAGE_HASH,
      to: V2_STORAGE_HASH,
      ops: [createPostsStoreOp, createPostsByAuthorIdIndexOp],
    });

    const dirs2 = await getMigrationDirs(cwd);
    expect(dirs2).toHaveLength(2);

    const r4 = await cli(["migration", "contract-space"], { cwd });
    expect(r4.exitCode).toBe(0);
    expect(r4.stderr).toContain("2 migration");

    const generated2 = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
    expect(generated2).toContain(dirs1[0]);
    expect(generated2).toContain("20260604T1029_add_posts");
    // Baseline must appear before add_posts in the migrations array
    const baselineIdx = generated2.indexOf(dirs1[0]);
    const addPostsIdx = generated2.indexOf("20260604T1029_add_posts");
    expect(baselineIdx).toBeLessThan(addPostsIdx);

    const r5 = await cli(["migration", "preflight"], { cwd });
    expect(r5.exitCode).toBe(0);
    expect(r5.stderr).toContain("Preflighting 2 migration(s)");
    expect(r5.stderr).toContain(dirs1[0] + " … ok");
    expect(r5.stderr).toContain("20260604T1029_add_posts … ok");
    expect(r5.stderr).toContain("Preflight passed");
  });

  it("migration plan auto-detects incremental (not a re-baseline) when migrations/app/ already has packages", async () => {
    const cwd = await setupTmpProject("e2e-no-double-baseline");
    await writeRawContractJson(cwd, CONTRACT_V1_NO_POSTS);

    const baseline = await cli(["migration", "plan"], { cwd });
    expect(baseline.exitCode).toBe(0);
    const existingDirs = await getMigrationDirs(cwd);
    expect(existingDirs).toHaveLength(1);
    const baselineDir = existingDirs[0]!;

    // Without --name it refuses (incremental mode requires one), but it does
    // NOT try to write a second `from: null` baseline alongside the existing one.
    const noName = await cli(["migration", "plan"], { cwd });
    expect(noName.exitCode).toBe(2);
    expect(noName.stderr).toContain("--name <slug> is required");
    expect(await getMigrationDirs(cwd)).toEqual([baselineDir]);

    await writeRawContractJson(cwd, CONTRACT_V2_WITH_POSTS);
    const withName = await cli(["migration", "plan", "--name", "add_posts"], { cwd });
    expect(withName.exitCode).toBe(0);

    const dirs = await getMigrationDirs(cwd);
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain(baselineDir);
    const newDir = dirs.find((d) => d !== baselineDir)!;
    const meta = JSON.parse(await readFile(join(cwd, "migrations", "app", newDir, "migration.json"), "utf-8")) as {
      from: string | null;
    };
    expect(meta.from).toBe(V1_STORAGE_HASH); // chained from the existing package, not from: null
  });

  it("migration contract-space after migration plan is idempotent", async () => {
    const cwd = await setupTmpProject("e2e-idempotent");
    await writeRawContractJson(cwd, CONTRACT_V1_NO_POSTS);
    await cli(["migration", "plan"], { cwd });

    const r1 = await cli(["migration", "contract-space"], { cwd });
    expect(r1.exitCode).toBe(0);
    const out1 = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");

    const r2 = await cli(["migration", "contract-space"], { cwd });
    expect(r2.exitCode).toBe(0);
    const out2 = await readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");

    expect(out1).toBe(out2);
  });
});
