import { dirname, join, resolve } from "pathe";
import { flag } from "@prisma/cli-engine";
import { CliStructuredError, notOk, ok } from "@prisma/cli-engine/protocol";
import { createCollectingSink, presentationsFromSink } from "../collecting-sink";
import { defineIdbCommand } from "../define-command";
import { requireContractPath, resolveMigrationsDir } from "./paths";

export const migrationContractSpaceCommand = defineIdbCommand({
  help: {
    summary: "Regenerate contract-space.generated.ts from migrations/app/",
    description:
      "Reads every migration package under <migrationsDir>/app/, validates the\n" +
      "chain's connectivity, and emits a generated TypeScript module that bundles\n" +
      "them into a ContractSpace.",
    examples: ["migration contract-space", "migration contract-space --out src/lib/prisma/contract-space.ts"],
  },
  args: {
    flags: {
      contract: flag.string({
        brief: "Path to contract.json (default: orm.contract.output)",
        placeholder: "path",
      }),
      migrationsDir: flag.string({
        brief: "Path to the migrations root (default: orm.migrations.dir)",
        placeholder: "path",
      }),
      out: flag.string({
        brief: "Output file path (default: colocated with the resolved contract.json)",
        placeholder: "path",
      }),
    },
  },
  handler: async (args, ctx) => {
    const contractPath = requireContractPath(ctx.config, ctx.cwd, args.flags.contract);
    const migrationsDir = resolveMigrationsDir(ctx.config, ctx.cwd, args.flags.migrationsDir);
    const outPath =
      args.flags.out !== undefined
        ? resolve(ctx.cwd, args.flags.out)
        : join(dirname(contractPath), "contract-space.generated.ts");

    const { generateContractSpace } = await import("../../core/contract-space-codegen");
    const sink = createCollectingSink();
    const exitCode = await generateContractSpace({
      migrationsDir,
      contractPath,
      outPath,
      out: sink.out,
      err: sink.err,
    });

    if (exitCode !== 0) {
      return notOk(
        new CliStructuredError("IDB-CLI.CONTRACT_SPACE_FAILED", sink.fullText() || "migration contract-space failed.")
      );
    }
    return ok(ctx.present({ data: { exitCode, outPath } }, presentationsFromSink(sink, exitCode)));
  },
});
