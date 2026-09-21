import { flag } from "@prisma/cli-engine";
import { CliStructuredError, notOk, ok } from "@prisma/cli-engine/protocol";
import { createCollectingSink, presentationsFromSink } from "../collecting-sink";
import { defineIdbCommand } from "../define-command";
import { resolveMigrationsDir } from "./paths";

export const migrationPreflightCommand = defineIdbCommand({
  help: {
    summary: "Validate the migration chain against fake-indexeddb",
    description:
      "Walks every migration package under <migrationsDir>/app/ in chain order,\n" +
      "applying each package's ops.json against a fresh fake-indexeddb instance.\n" +
      "Catches 'the chain doesn't apply cleanly' — not schema drift.",
    examples: ["migration preflight"],
  },
  args: {
    flags: {
      migrationsDir: flag.string({
        brief: "Path to the migrations root (default: orm.migrations.dir)",
        placeholder: "path",
      }),
    },
  },
  handler: async (args, ctx) => {
    const migrationsDir = resolveMigrationsDir(ctx.config, ctx.cwd, args.flags.migrationsDir);

    const { runPreflight } = await import("../../core/preflight");
    const sink = createCollectingSink();
    const exitCode = await runPreflight({ migrationsDir, out: sink.out, err: sink.err });

    if (exitCode !== 0) {
      return notOk(new CliStructuredError("IDB-CLI.PREFLIGHT_FAILED", sink.fullText() || "Preflight failed."));
    }
    return ok(ctx.present({ data: { exitCode } }, presentationsFromSink(sink, exitCode)));
  },
});
