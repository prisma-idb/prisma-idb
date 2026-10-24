/**
 * End-to-end regression test for the full prisma-idb migration pipeline.
 *
 * One journey drives the CLI commands in the order a developer runs them on a real project, in a
 * temp directory, with contract JSON fixtures derived from `apps/prisma-orm-usage`:
 *
 *   Phase 1 (baseline):  migration plan, preflight
 *   Phase 2 (add posts): migration plan --name, preflight
 *
 * What each command computes (baseline and incremental package contents, hashes, snapshots, the
 * `--name` requirement) is covered without a subprocess in `family-idb/test/migration-plan.test.ts`.
 * The journey keeps what only the real binary and the real files can show: the commands compose,
 * and each reads what the one before it wrote.
 *
 * The contract fixtures are the exact JSON snapshots produced by `prisma contract emit` for the
 * corresponding schema states.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, getMigrationDirs, importContractSpace, setupTmpProject, writeRawContractJson } from "./_helpers";

// ── Contract fixtures ────────────────────────────────────────────────────────
// Exact JSON snapshots from apps/prisma-orm-usage: the "no-posts" state
// (end-contract.json from the baseline migration) and the "with-posts" state
// (the current contract.json). Preflight recomputes each head snapshot's storage hash from its
// content, so these hashes must match the fixtures below.

const V1_STORAGE_HASH = "0d984fb7d472d505375d020ad80c5b61e4e7ebfa8f285e3da51170ef3560b936";
const V2_STORAGE_HASH = "122c98a5111c07549f24a259e93c2db8bcdd68bf1ee5310718c618ddd9fe8a0d";

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
    namespaces: { __unbound__: { id: "__unbound__", entries: {} } },
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
    namespaces: { __unbound__: { id: "__unbound__", entries: {} } },
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

// The journey spawns CLI subprocesses in sequence; a loaded CI runner can exceed the 30 s default.
describe("migration pipeline e2e", { timeout: 120_000 }, () => {
  it("plan bundles a baseline and an incremental migration that both pass preflight", async () => {
    // Regression: a command that writes output the next command cannot read, such as a plan whose
    // snapshot fails preflight, or a contract-space module that omits the newest package.
    const cwd = await setupTmpProject("e2e-full-pipeline");
    const contractSpacePath = join(cwd, "src", "lib", "prisma", "contract-space.generated.ts");
    await writeRawContractJson(cwd, CONTRACT_V1_NO_POSTS);

    // ── Phase 1: baseline ───────────────────────────────────────────────────

    expect((await cli(["migration", "plan"], { cwd })).exitCode).toBe(0);
    const [baselineDir] = await getMigrationDirs(cwd);
    expect(await getMigrationDirs(cwd)).toHaveLength(1);

    const space1 = await importContractSpace(cwd, contractSpacePath);
    expect(space1.headRef.hash).toBe(V1_STORAGE_HASH);
    expect(space1.migrations.map(({ dirName }) => dirName)).toEqual([baselineDir]);

    const preflight1 = await cli(["migration", "preflight"], { cwd });
    expect(preflight1.exitCode).toBe(0);
    expect(preflight1.stderr).toContain("Preflight passed");

    // ── Phase 2: add the posts model ─────────────────────────────────────────

    await writeRawContractJson(cwd, CONTRACT_V2_WITH_POSTS);

    // Incremental mode must refuse a second baseline, and must not write one while refusing.
    const unnamed = await cli(["migration", "plan"], { cwd });
    expect(unnamed.exitCode).toBe(2);
    expect(unnamed.stderr).toContain("--name <slug> is required");
    expect(await getMigrationDirs(cwd)).toEqual([baselineDir]);

    expect((await cli(["migration", "plan", "--name", "add_posts"], { cwd })).exitCode).toBe(0);
    const dirs = await getMigrationDirs(cwd);
    expect(dirs).toHaveLength(2);
    const addPostsDir = dirs.find((dir) => dir !== baselineDir)!;

    const space2 = await importContractSpace(cwd, contractSpacePath);
    expect(space2.headRef.hash).toBe(V2_STORAGE_HASH);
    expect(space2.migrations.map(({ dirName }) => dirName)).toEqual([baselineDir, addPostsDir]);

    const preflight2 = await cli(["migration", "preflight"], { cwd });
    expect(preflight2.exitCode).toBe(0);
    expect(preflight2.stderr).toContain("Preflighting 2 migration(s)");
    expect(preflight2.stderr).toContain("Preflight passed");

    const head = JSON.parse(await readFile(join(cwd, "migrations", "app", addPostsDir, "migration.json"), "utf-8")) as {
      from: string;
      to: string;
    };
    expect(head).toMatchObject({ from: V1_STORAGE_HASH, to: V2_STORAGE_HASH });
  });
});
