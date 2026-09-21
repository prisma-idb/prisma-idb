import type { PrismaNextConfig } from "@prisma/orm-toolchain/config-loader";
import { CliStructuredError } from "@prisma/cli-engine/protocol";
import { resolve } from "pathe";

/**
 * Resolves the contract/migrations paths a command needs from the already
 * finalized (absolute-paths) `orm` config section, with CLI flag overrides
 * winning when supplied. `ctx.config` arrives finalized by
 * `defineIdbCommand` (see `../define-command.ts`), so `config.contract.output`
 * and `config.migrations.dir` are already absolute — only an explicit
 * `--contract`/`--migrations-dir` flag (relative to `cwd`) needs resolving
 * here.
 */
export function requireContractPath(config: PrismaNextConfig, cwd: string, override: string | undefined): string {
  if (override !== undefined) return resolve(cwd, override);
  const output = config.contract?.output;
  if (output === undefined) {
    throw new CliStructuredError(
      "IDB-CLI.CONTRACT_PATH_MISSING",
      "config.contract.output is required to resolve the contract path.",
      {
        why: "Neither --contract nor prisma.config.ts's orm.contract.output supplied a path.",
        nextActions: [
          { kind: "edit-file", label: "Set contract.output in prisma.config.ts, or pass --contract explicitly" },
        ],
      }
    );
  }
  return output;
}

/**
 * `finalizeConfig` always resolves `migrations.dir` to an absolute path
 * (defaulting to `<configDir>/migrations` when unset); the fallback here is
 * defensive, not the expected path.
 */
export function resolveMigrationsDir(config: PrismaNextConfig, cwd: string, override: string | undefined): string {
  if (override !== undefined) return resolve(cwd, override);
  return config.migrations?.dir ?? resolve(cwd, "migrations");
}
