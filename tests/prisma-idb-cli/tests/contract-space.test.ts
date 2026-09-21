/**
 * CLI regression tests for `prisma-idb migration contract-space`.
 *
 * Each test scaffolds a tmpdir containing a `migrations/app/<...>` fixture
 * + a `contract.json`, spawns the built CLI binary via execa, and asserts
 * on stderr / exit code / the generated module's contents.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cli,
  createCommentsStoreOp,
  createMarkerStoreOp,
  createPostsStoreOp,
  createUsersStoreOp,
  setupTmpProject,
  writeContractJson,
  writePackage,
} from "./_helpers";

const HASH_BASELINE = "sha256:baseline" as const;
const HASH_ADDPOSTS = "sha256:addposts" as const;
const HASH_ADDCOMMENTS = "sha256:addcomments" as const;

async function readGenerated(cwd: string): Promise<string> {
  return readFile(join(cwd, "src", "lib", "prisma", "contract-space.generated.ts"), "utf-8");
}

describe("prisma-idb migration contract-space", () => {
  it("emits an empty-migrations module when no packages exist", async () => {
    const cwd = await setupTmpProject("codegen-empty");
    await writeContractJson(cwd, HASH_BASELINE);

    const { stderr, exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("0 migrations");

    const out = await readGenerated(cwd);
    expect(out).toContain("THIS FILE IS AUTO-GENERATED");
    expect(out).toContain("migrations: [],");
    expect(out).toContain('hash: ""');
  });

  it("emits one import pair per package and inlines headRef from the last package's .to", async () => {
    const cwd = await setupTmpProject("codegen-two");
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

    const { stderr, exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("2 migrations");

    const out = await readGenerated(cwd);
    expect(out).toContain("import mig_0001_baseline_meta");
    expect(out).toContain("import mig_0001_baseline_ops");
    expect(out).toContain("import mig_0002_addPosts_meta");
    expect(out).toContain("import mig_0002_addPosts_ops");
    expect(out).toContain('dirName: "0001_baseline"');
    expect(out).toContain('dirName: "0002_addPosts"');
    expect(out).toContain("hash: mig_0002_addPosts_meta.to");
    expect(out).toContain("invariants: (mig_0002_addPosts_meta.providedInvariants");
  });

  it("orders packages by from/to chain — NOT by lexicographic dir name (regression)", async () => {
    // Reproduces the bug we hit when `migration plan` emitted `T0337`
    // (HHMM) while a hand-authored baseline used `T120000` (HHMMSS). A
    // naive sort puts `0337` before `1200` but the chain starts at the
    // baseline (`from: null`).
    const cwd = await setupTmpProject("codegen-chainorder");
    await writeContractJson(cwd, HASH_ADDCOMMENTS);
    // Note: addcomments has a lexicographically EARLIER dirName than baseline.
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
      ops: [createMarkerStoreOp, createUsersStoreOp],
    });

    const { exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(0);

    const out = await readGenerated(cwd);
    // Baseline must come first in the `migrations:` array.
    const baselineIdx = out.indexOf('"20260527T120000_baseline"');
    const addCommentsIdx = out.indexOf('"20260527T0337_addcomments"');
    expect(baselineIdx).toBeGreaterThan(-1);
    expect(addCommentsIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeLessThan(addCommentsIdx);

    // headRef should point at the last package's .to (addcomments).
    expect(out).toContain("hash: mig_20260527T0337_addcomments_meta.to");
  });

  it("does NOT write migrations/refs/ (regression — would collide with framework space scanner)", async () => {
    // Pre-Phase-7.7-fix, the codegen wrote a sibling `migrations/refs/head.json`
    // file. The framework's `prisma-idb migration plan` then refused with
    // `orphanSpaceDir: refs`. The fix inlines headRef inside the generated
    // module so no top-level `refs/` exists on disk.
    const cwd = await setupTmpProject("codegen-no-refs");
    await writeContractJson(cwd, HASH_BASELINE);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp],
    });

    await cli(["migration", "contract-space"], { cwd });
    expect(existsSync(join(cwd, "migrations", "refs"))).toBe(false);
  });

  it("is idempotent — re-running produces byte-identical output", async () => {
    const cwd = await setupTmpProject("codegen-idempotent");
    await writeContractJson(cwd, HASH_BASELINE);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp],
    });

    await cli(["migration", "contract-space"], { cwd });
    const first = await readGenerated(cwd);
    await cli(["migration", "contract-space"], { cwd });
    const second = await readGenerated(cwd);

    expect(first).toBe(second);
  });

  it("rejects a broken chain (missing edge)", async () => {
    const cwd = await setupTmpProject("codegen-broken-edge");
    await writeContractJson(cwd, HASH_ADDPOSTS);
    // Only the second package; no baseline with from: null.
    await writePackage({
      cwd,
      dirName: "0001_addPosts",
      from: HASH_BASELINE,
      to: HASH_ADDPOSTS,
      ops: [createPostsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/chain broken/i);
    expect(stderr).toContain("null"); // expected from === null (the missing baseline)
  });

  it("rejects two packages claiming the same `from` (linearity violation)", async () => {
    const cwd = await setupTmpProject("codegen-chain-fork");
    await writeContractJson(cwd, HASH_ADDPOSTS);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp],
    });
    // Two packages both claim `from: HASH_BASELINE`.
    await writePackage({
      cwd,
      dirName: "0002_addPosts",
      from: HASH_BASELINE,
      to: HASH_ADDPOSTS,
      ops: [createPostsStoreOp],
    });
    await writePackage({
      cwd,
      dirName: "0003_addPostsAlt",
      from: HASH_BASELINE,
      to: "sha256:alt",
      ops: [createPostsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/chain conflict/i);
  });

  it("rejects orphan packages (not reachable from baseline)", async () => {
    const cwd = await setupTmpProject("codegen-orphan");
    await writeContractJson(cwd, HASH_BASELINE);
    await writePackage({
      cwd,
      dirName: "0001_baseline",
      from: null,
      to: HASH_BASELINE,
      ops: [createMarkerStoreOp],
    });
    // Orphan: starts from a hash that no prior package reaches.
    await writePackage({
      cwd,
      dirName: "0002_orphan",
      from: "sha256:unreachable",
      to: "sha256:orphan-tip",
      ops: [createPostsStoreOp],
    });

    const { stderr, exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/orphan/i);
    expect(stderr).toContain("0002_orphan");
  });

  it("handles a missing migrations/app/ dir gracefully (empty module)", async () => {
    // Some early-bootstrap state: contract emitted, no migrations yet.
    const cwd = await setupTmpProject("codegen-no-app-dir");
    await writeContractJson(cwd, HASH_BASELINE);
    // Don't create migrations/app/ — _helpers does, but let's remove it.
    const { rm } = await import("node:fs/promises");
    await rm(join(cwd, "migrations", "app"), { recursive: true });

    const { exitCode } = await cli(["migration", "contract-space"], { cwd });
    expect(exitCode).toBe(0);

    const out = await readGenerated(cwd);
    expect(out).toContain("migrations: [],");
  });
});
