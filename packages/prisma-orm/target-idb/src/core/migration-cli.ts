import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { MigrationMetadata } from "@prisma/orm-toolchain/migration-tools/metadata";
import { buildMigrationArtifacts, isDirectEntrypoint } from "@prisma/orm-toolchain/migration-tools/migration";
import { dirname, join } from "pathe";
import type { IdbMigration } from "./idb-migration";

type IdbMigrationConstructor = new () => IdbMigration;

/**
 * Self-emit CLI invoked by an authored `migration.ts` file:
 *
 *   `MigrationCLI.run(import.meta.url, M);`
 *
 * When the file is run as a node entrypoint (`node migration.ts`), regenerates
 * `ops.json` and `migration.json` next to the file from the migration class's
 * current `operations` getter and `describe()` output. When the file is merely
 * imported (e.g. by `contract-space.generated.ts`), returns 0 without side
 * effects.
 *
 * IDB migrations are pure data — no SQL string compilation, no adapter-driven
 * materialization — so this shim deliberately skips config loading and
 * `ControlStack` assembly. That keeps the shim free of the workspace-internal,
 * never-published `@internal/cli` package (which is what vendor's
 * `MigrationCLI.run` depends on, and what builds the public `prisma` binary).
 */
export class MigrationCLI {
  static async run(importMetaUrl: string, MigrationClass: IdbMigrationConstructor): Promise<number> {
    if (!isDirectEntrypoint(importMetaUrl)) return 0;

    const { values } = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: false,
    });

    if (values.help) {
      process.stdout.write(
        "Usage: node migration.ts [--dry-run]\n" +
          "\n" +
          "  Self-emits ops.json and migration.json next to this file from the\n" +
          "  migration class's describe() and operations getter.\n" +
          "\n" +
          "  Serializes the DDL ops defined in this file into JSON artifacts\n" +
          "  consumed by the migration runner at design-time (preflight) and\n" +
          "  runtime (browser auto-migrate). A no-op when imported.\n" +
          "\n" +
          "Options:\n" +
          "  --dry-run  Print artifacts to stdout without writing files\n" +
          "  --help     Show this message\n"
      );
      return 0;
    }

    const instance = new MigrationClass();
    const migrationDir = dirname(fileURLToPath(importMetaUrl));
    const metaPath = join(migrationDir, "migration.json");
    const opsPath = join(migrationDir, "ops.json");

    let existing: Partial<MigrationMetadata> | null = null;
    try {
      const raw = readFileSync(metaPath, "utf-8");
      existing = JSON.parse(raw) as Partial<MigrationMetadata>;
    } catch {
      // No prior metadata — fresh emit.
    }

    const { opsJson, metadataJson } = await buildMigrationArtifacts(instance, existing);

    if (values["dry-run"]) {
      process.stdout.write(`--- migration.json ---\n${metadataJson}\n`);
      process.stdout.write(`--- ops.json ---\n${opsJson}\n`);
      return 0;
    }

    writeFileSync(opsPath, opsJson);
    writeFileSync(metaPath, metadataJson);
    process.stdout.write(`Wrote ops.json + migration.json to ${migrationDir}\n`);
    return 0;
  }
}
