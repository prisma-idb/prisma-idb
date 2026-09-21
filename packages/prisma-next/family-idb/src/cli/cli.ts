import type { Cli, HostProcess, Runtime } from "@prisma/cli-engine";
import { createCli, loadConfig } from "@prisma/cli-engine";
import { CliStructuredError } from "@prisma/cli-engine/protocol";
import packageJson from "../../package.json" with { type: "json" };
import { idbCommandFamily } from "./family";

export const BIN_NAME = "prisma-idb";

export const BIN_GROUPS = {
  migration: {
    brief: "On-disk migration management commands",
    description:
      "Plan, bundle, and validate IDB migration packages. Migrations are\n" +
      "contract-to-contract edges stored as versioned directories under migrations/.",
  },
} as const;

export function createIdbCli(): Cli {
  return createCli({
    name: BIN_NAME,
    version: packageJson.version,
    commandFamilies: [idbCommandFamily],
    groups: BIN_GROUPS,
    commands: idbCommandFamily.commands,
    help: {
      tagline: "IDB-target tooling for Prisma 8",
      description: "Migration authoring for IndexedDB projects — no live database on the Node side to consult.",
    },
  });
}

/** Everything environmental the engine is given, adapted from the host process once. */
export function runtimeFromProcess(proc: HostProcess): Runtime {
  return {
    stdout: { write: (text) => void proc.stdout.write(text) },
    stderr: { write: (text) => void proc.stderr.write(text) },
    stdin: proc.stdin,
    cwd: proc.cwd(),
    env: proc.env,
    isTty: {
      stdin: proc.stdin.isTTY === true,
      stdout: proc.stdout.isTTY === true,
      stderr: proc.stderr.isTTY === true,
    },
    host: {
      runtime: { name: "node", version: proc.version },
      platform: proc.platform,
      arch: proc.arch,
    },
    exit: (code) => proc.exit(code),
    onSignal: (callback) => {
      const onInterrupt = () => callback("SIGINT");
      const onTerminate = () => callback("SIGTERM");
      proc.on("SIGINT", onInterrupt);
      proc.on("SIGTERM", onTerminate);
      return () => {
        proc.off("SIGINT", onInterrupt);
        proc.off("SIGTERM", onTerminate);
      };
    },
    loadConfig: (configPath) => loadConfig(proc.cwd(), configPath),
    // Never reached: no command here declares `credentials`/`managesCredentials`,
    // so ctx.api is never constructed — required on Runtime regardless.
    managementApi: { baseUrl: "https://api.prisma.io" },
  };
}

const STARTUP_FAILURE_EXIT_CODE = 1;

function reportStartupFailure(proc: HostProcess, error: unknown): number {
  const normalized = CliStructuredError.is(error)
    ? error
    : new CliStructuredError("IDB-CLI.STARTUP_FAILURE", error instanceof Error ? error.message : String(error));
  proc.stderr.write(`✘ [${normalized.code}] ${normalized.message}\n`);
  return STARTUP_FAILURE_EXIT_CODE;
}

/** Parses, executes and settles one invocation; returns the exit code. */
export async function runIdbCli(proc: HostProcess): Promise<number> {
  try {
    return await createIdbCli().run(proc.argv.slice(2), runtimeFromProcess(proc));
  } catch (error) {
    return reportStartupFailure(proc, error);
  }
}
