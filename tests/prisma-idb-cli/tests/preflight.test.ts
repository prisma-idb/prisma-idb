/**
 * CLI regression tests for `prisma-idb migration preflight`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cli,
  createCommentsStoreOp,
  createMarkerStoreOp,
  createPostsStoreOp,
  createUsersStoreOp,
  indexOnMissingStoreOp,
  setupTmpProject,
  writeContractJson,
  writePackage,
} from "./_helpers";

const HASH_BASELINE = "sha256:baseline" as const;
// Storage hashes of the snapshots that `writeSnapshot` writes for the store sets below.
// Preflight recomputes a snapshot's hash from its content, so these must stay in sync with it.
const HASH_ADDPOSTS = "2aa2aa49d028300e4c6c5d3cc2629b25970314f7fd3617786a1f8cd7acf3f6c4" as const; // users, posts
const HASH_ADDCOMMENTS = "993a34045a90d0035fa3eefa576e434e70a29f21fb9d53b9360e2d578bdeb64a" as const; // users, posts, comments

async function writeSnapshot(cwd: string, hash: string, storeNames: string[]): Promise<void> {
  const dir = join(cwd, "migrations", "snapshots", hash);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "contract.json"),
    JSON.stringify({
      target: "idb",
      targetFamily: "idb",
      roots: {},
      domain: { namespaces: { __unbound__: { models: {} } } },
      storage: {
        storageHash: hash,
        stores: Object.fromEntries(storeNames.map((name) => [name, { keyPath: "id" }])),
        namespaces: { __unbound__: { id: "__unbound__", entries: {} } },
      },
      capabilities: {},
      extensions: {},
      meta: {},
    }),
    "utf-8"
  );
}

describe("prisma-idb migration preflight", () => {
  it("exits 0 with 'Nothing to preflight' when no packages exist", async () => {
    const cwd = await setupTmpProject("preflight-empty");
    await writeContractJson(cwd, HASH_BASELINE);

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Nothing to preflight");
  });

  it("exits 0 when every migration applies cleanly against fake-indexeddb", async () => {
    const cwd = await setupTmpProject("preflight-happy");
    await writeSnapshot(cwd, HASH_ADDPOSTS, ["users", "posts"]);
    await writeContractJson(cwd, HASH_ADDPOSTS);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp, createUsersStoreOp],
    });
    await writePackage({
      cwd,
      dirName: "0002_addPosts",
      from: HASH_BASELINE,
      to: HASH_ADDPOSTS,
      ops: [createPostsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Preflighting 2 migration(s)");
    expect(stderr).toContain("0001_baseline … ok");
    expect(stderr).toContain("0002_addPosts … ok");
    expect(stderr).toContain("Preflight passed");
  });

  it("fails with a readable schema diff even when every package hash is valid", async () => {
    const cwd = await setupTmpProject("preflight-drift");
    await writeSnapshot(cwd, HASH_ADDPOSTS, ["users", "posts"]);
    await writeContractJson(cwd, HASH_ADDPOSTS);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_ADDPOSTS,
      ops: [createMarkerStoreOp, createUsersStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("IDB-CLI.PREFLIGHT_FAILED");
    expect(stderr).toContain('Object store "posts" defined in contract is missing');
  });

  it("exits 1 with a clear error when a DDL op fails (index on non-existent store)", async () => {
    const cwd = await setupTmpProject("preflight-bad-ddl");
    await writeContractJson(cwd, HASH_ADDPOSTS);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp, createUsersStoreOp],
    });
    await writePackage({
      cwd,
      dirName: "0002_badIndex",
      from: HASH_BASELINE,
      to: HASH_ADDPOSTS,
      ops: [indexOnMissingStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("0001_baseline … ok");
    expect(stderr).toContain("0002_badIndex … FAILED");
    expect(stderr).toContain("Preflight failed");
  });

  it("orders by from/to chain — NOT by lexicographic dir name (regression)", async () => {
    // Same regression as codegen: mixed timestamp formats must not break
    // chain order. Preflight chain-walks too.
    const cwd = await setupTmpProject("preflight-chainorder");
    await writeSnapshot(cwd, HASH_ADDCOMMENTS, ["users", "posts", "comments"]);
    await writeContractJson(cwd, HASH_ADDCOMMENTS);
    await writePackage({
      cwd,
      dirName: "20260527T0337_addcomments",
      from: HASH_BASELINE,
      to: HASH_ADDCOMMENTS,
      ops: [createCommentsStoreOp],
    });
    await writePackage({
      cwd,
      dirName: "20260527T120000_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp, createUsersStoreOp, createPostsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(0);
    // Baseline ran first; addcomments ran second.
    const baselineIdx = stderr.indexOf("20260527T120000_baseline");
    const addCommentsIdx = stderr.indexOf("20260527T0337_addcomments");
    expect(baselineIdx).toBeGreaterThan(-1);
    expect(addCommentsIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeLessThan(addCommentsIdx);
  });

  it("rejects a broken chain before opening fake-indexeddb", async () => {
    const cwd = await setupTmpProject("preflight-broken-chain");
    await writeContractJson(cwd, HASH_ADDCOMMENTS);
    // Missing baseline.
    await writePackage({
      cwd,
      dirName: "0001_addcomments",
      from: HASH_BASELINE,
      to: HASH_ADDCOMMENTS,
      ops: [createCommentsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/chain broken/i);
  });

  it("rejects two packages claiming the same `from` (linearity violation)", async () => {
    const cwd = await setupTmpProject("preflight-chain-fork");
    await writeContractJson(cwd, HASH_BASELINE);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp],
    });
    await writePackage({
      cwd,
      dirName: "0002_a",
      from: HASH_BASELINE,
      to: HASH_ADDPOSTS,
      ops: [createPostsStoreOp],
    });
    await writePackage({
      cwd,
      dirName: "0003_b",
      from: HASH_BASELINE,
      to: HASH_ADDCOMMENTS,
      ops: [createCommentsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/chain conflict/i);
  });

  it("rejects non-IDB ops in ops.json", async () => {
    const cwd = await setupTmpProject("preflight-non-idb-op");
    await writeContractJson(cwd, HASH_BASELINE);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [
        {
          kind: "rawSql", // Not a valid IDB op kind
          id: "sql.fake",
          label: "fake",
          operationClass: "additive",
          sql: "SELECT 1",
        },
      ],
    });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/non-idb op/i);
  });
});
