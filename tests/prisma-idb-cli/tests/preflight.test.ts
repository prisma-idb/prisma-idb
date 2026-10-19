/**
 * CLI tests for `prisma-idb migration preflight`.
 *
 * What preflight decides (DDL replay, schema drift, a stale emitted contract, hash mismatches,
 * non-IDB operations, chain order and conflicts) is covered without a subprocess by `runPreflight`
 * in `family-idb/test/preflight.test.ts`. A passing run through the real binary is part of
 * `migration-pipeline.test.ts`. This file keeps what only the binary can show: a failed preflight
 * becomes exit code 2 with a structured error code and the cause on stderr.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cli,
  createMarkerStoreOp,
  createPostsStoreOp,
  createUsersStoreOp,
  setupTmpProject,
  writeContractJson,
  writePackage,
} from "./_helpers";

const HASH_BASELINE = "sha256:baseline" as const;
// Storage hash of the snapshot that `writeSnapshot` writes for the stores `users` and `posts`.
// Preflight recomputes a snapshot's hash from its content, so this must stay in sync with it.
const HASH_ADDPOSTS = "2aa2aa49d028300e4c6c5d3cc2629b25970314f7fd3617786a1f8cd7acf3f6c4" as const;

async function writeUsersAndPostsSnapshot(cwd: string): Promise<void> {
  const dir = join(cwd, "migrations", "snapshots", HASH_ADDPOSTS);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "contract.json"),
    JSON.stringify({
      target: "idb",
      targetFamily: "idb",
      roots: {},
      domain: { namespaces: { __unbound__: { models: {} } } },
      storage: {
        storageHash: HASH_ADDPOSTS,
        stores: { users: { keyPath: "id" }, posts: { keyPath: "id" } },
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
  it("exits 2 with a structured error and a readable schema diff when the chain does not build the head contract", async () => {
    // Regression: a failing preflight that exits 0 would let CI ship a migration chain that
    // cannot produce the schema the app expects.
    const cwd = await setupTmpProject("preflight-drift");
    await writeUsersAndPostsSnapshot(cwd);
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

  it("exits 2 and names the cause when two migrations start from the same schema", async () => {
    // Regression: a forked chain (two branches both adding a migration) replayed as if it were linear.
    const cwd = await setupTmpProject("preflight-chain-fork");
    await writeContractJson(cwd, HASH_BASELINE);
    await writePackage({ cwd, dirName: "0001_baseline", from: null, to: HASH_BASELINE, ops: [createMarkerStoreOp] });
    await writePackage({ cwd, dirName: "0002_a", from: HASH_BASELINE, to: "sha256:a", ops: [createPostsStoreOp] });
    await writePackage({ cwd, dirName: "0003_b", from: HASH_BASELINE, to: "sha256:b", ops: [createUsersStoreOp] });

    const { stderr, exitCode } = await cli(["migration", "preflight"], { cwd });

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/chain conflict/i);
  });
});
