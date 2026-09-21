import { flag } from "@prisma/cli-engine";
import { CliStructuredError, notOk, ok } from "@prisma/cli-engine/protocol";
import { createCollectingSink, presentationsFromSink } from "../collecting-sink";
import { defineIdbCommand } from "../define-command";
import { requireContractPath, resolveMigrationsDir } from "./paths";

export const migrationPlanCommand = defineIdbCommand({
  help: {
    summary: "Plan the next IDB migration package (auto-detects baseline vs. incremental)",
    description:
      "Compares the emitted contract against the latest on-disk migration state and\n" +
      "produces a new migration package with the required operations. Offline —\n" +
      "never opens IndexedDB (there is no live database on the Node side to consult).",
    examples: ["migration plan", "migration plan --name add-posts", "migration plan --space idb-sync"],
  },
  args: {
    flags: {
      name: flag.string({
        brief: 'Directory slug (default: "baseline" for a fresh space; required otherwise)',
        placeholder: "slug",
      }),
      space: flag.string({
        brief: 'Contract-space id (default: "app"). See ADR 212 for extension-space migrations.',
        placeholder: "id",
      }),
      contract: flag.string({
        brief: "Path to contract.json (default: orm.contract.output)",
        placeholder: "path",
      }),
      migrationsDir: flag.string({
        brief: "Path to the migrations root (default: orm.migrations.dir)",
        placeholder: "path",
      }),
    },
  },
  handler: async (args, ctx) => {
    const contractPath = requireContractPath(ctx.config, ctx.cwd, args.flags.contract);
    const migrationsDir = resolveMigrationsDir(ctx.config, ctx.cwd, args.flags.migrationsDir);

    const { migrationPlan } = await import("../../core/migration-plan");
    const sink = createCollectingSink();
    const exitCode = await migrationPlan({
      migrationsDir,
      contractPath,
      out: sink.out,
      err: sink.err,
      ...(args.flags.name !== undefined && { name: args.flags.name }),
      ...(args.flags.space !== undefined && { spaceId: args.flags.space }),
    });

    if (exitCode === 2) {
      return notOk(
        new CliStructuredError(
          "IDB-CLI.MIGRATION_NAME_REQUIRED",
          sink.fullText() || "--name <slug> is required when generating an incremental migration."
        )
      );
    }
    if (exitCode !== 0) {
      return notOk(
        new CliStructuredError("IDB-CLI.MIGRATION_PLAN_FAILED", sink.fullText() || "migration plan failed.")
      );
    }
    return ok(ctx.present({ data: { exitCode } }, presentationsFromSink(sink, exitCode)));
  },
});
