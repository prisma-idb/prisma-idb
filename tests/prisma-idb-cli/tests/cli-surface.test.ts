/**
 * CLI surface tests — help, unknown commands, no-arg invocation.
 *
 * The CLI is a `@prisma/cli-engine` shell (`idbCommandFamily`, mounted via
 * `createCli`) — all migration-package commands live under a `migration`
 * group (`migration plan`, `migration contract-space`, `migration
 * preflight`). Per the CLI Style Guide, explicit `--help` is DATA (stdout,
 * exit 0); help/usage printed as error decoration (unknown command) and
 * every structured failure land on stderr — confirmed empirically against
 * the built binary in both cases. The bare no-args invocation is its own
 * case: it bypasses format detection and always renders to stderr,
 * regardless of `--format`.
 */

import { describe, expect, it } from "vitest";
import { cli, setupTmpProject } from "./_helpers";

describe("prisma-idb (CLI surface)", () => {
  it("no subcommand prints help and exits 0", async () => {
    const cwd = await setupTmpProject("cli-noargs");
    const { stderr, exitCode } = await cli([], { cwd });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("prisma-idb");
    expect(stderr).toContain("migration");
  });

  it("`--help` prints usage and lists the migration command group", async () => {
    const cwd = await setupTmpProject("cli-dashhelp");
    const { stdout, exitCode } = await cli(["--help"], { cwd });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("prisma-idb");
    expect(stdout).toContain("migration");
  });

  it("`migration --help` lists plan, contract-space, and preflight", async () => {
    const cwd = await setupTmpProject("cli-migration-help");
    const { stdout, exitCode } = await cli(["migration", "--help"], { cwd });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("plan");
    expect(stdout).toContain("contract-space");
    expect(stdout).toContain("preflight");
  });

  it("unknown top-level subcommand exits non-zero with an error", async () => {
    const cwd = await setupTmpProject("cli-unknown");
    const { stderr, exitCode } = await cli(["frobnicate"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("No command registered");
    expect(stderr).toContain("frobnicate");
  });

  it("unknown migration subcommand exits non-zero with an error", async () => {
    const cwd = await setupTmpProject("cli-unknown-migration-sub");
    const { stderr, exitCode } = await cli(["migration", "frobnicate"], { cwd });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("No command registered");
  });
});
