/**
 * CLI test for `prisma-idb migration contract-space`.
 *
 * What the command writes is covered without a subprocess by `generateContractSpace` in
 * `family-idb/test/contract-space-codegen.test.ts` (chain order, empty and missing migration
 * directories, idempotence, no `refs/` directory) and, through the real binary, by
 * `migration-pipeline.test.ts` and `config-resolution.test.ts`. This file keeps the one thing only
 * the binary can show: a failure becomes exit code 2 with the cause on stderr.
 */

import { describe, expect, it } from "vitest";
import { cli, createPostsStoreOp, setupTmpProject, writeContractJson, writePackage } from "./_helpers";

describe("prisma-idb migration contract-space", () => {
  it("exits 2 and names the cause when the migration chain has no baseline", async () => {
    // Regression: a library error that surfaced as exit 0, or as a stack trace with no message.
    const cwd = await setupTmpProject("codegen-broken-chain");
    await writeContractJson(cwd, "sha256:addposts");
    await writePackage({
      cwd,
      dirName: "0001_addPosts",
      from: "sha256:baseline",
      to: "sha256:addposts",
      ops: [createPostsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "contract-space"], { cwd });

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/chain broken/i);
  });
});
