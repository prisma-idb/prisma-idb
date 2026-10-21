/// <reference types="node" />

import { getConfig, getDMMF } from "@prisma/internals";
import { createDAG } from "@prisma-idb/idb-client-generator/dist/fileCreators/batch-processor/createDAG";
import { parseGeneratorConfig } from "@prisma-idb/idb-client-generator/dist/helpers/parseGeneratorConfig";
import { execa } from "execa";
import fs from "fs/promises";
import { describe, expect, it } from "vitest";
import { schemaPath } from "./_generate";

/**
 * Runs the checks the generator applies before it writes any file: it parses the generator
 * config for the schema, then builds the ownership graph. This is the same sequence `generator.ts`
 * runs, minus the process start-up that `prisma generate` adds to every case.
 */
async function diagnose(schemaFile: string): Promise<void> {
  const datamodel = await fs.readFile(schemaPath(schemaFile), "utf8");
  const [dmmf, config] = await Promise.all([getDMMF({ datamodel }), getConfig({ datamodel })]);
  const generator = config.generators.find((g) => g.provider.value === "idb-client-generator")!;
  const otherGenerators = config.generators.filter((g) => g !== generator);

  const parsed = parseGeneratorConfig({ dmmf, generator, otherGenerators } as never);
  if (parsed.outboxSync) createDAG(parsed.filteredModels as never, parsed.rootModel as never);
}

describe("schema diagnostics", () => {
  it.each([
    ["no-root-model-with-sync", `"rootModel" must be specified in the generator config when "outboxSync" is enabled.`],
    ["missing-changelog", `A "Changelog" model is required when "outboxSync" is enabled.`],
    ["changelog-manually-included", `"Changelog" model is automatically excluded and cannot be manually included.`],
    ["extra-changelog-field", `Changelog model must have exactly 6 fields, but has 7.`],
    ["invalid-changelog-operation-field-type", `Changelog.operation must be of type ChangeOperation, got String.`],
    ["wrong-changelog-id-default", `Changelog.id @default must be uuid(7), got uuid.`],
    [
      "extra-change-operation-enum-value",
      `ChangeOperation enum must have exactly 3 values (create, update, delete), but has 4.`,
    ],
    [
      "invalid-change-operation-enum-value",
      `ChangeOperation enum has invalid value "read". Only valid values are: create, update, delete.`,
    ],
    ["ownership-cycle-self", `Cycle detected in the model relationships involving model "Node".`],
    ["ownership-cycle-ambiguous", `Cycle detected in the model relationships involving model "Todo".`],
    [
      "autoincrement-id",
      `Model "TodoAutoincrementId" has @id field "id" with invalid default "autoincrement". Required: Use random defaults like uuid() or cuid() for all models (except rootModel) included in sync.`,
    ],
  ])("rejects %s", async (schema, message) => {
    // Regression: a schema the sync server cannot enforce ownership for must fail at generation
    // time, with a message that names the broken rule, rather than emit a client that cannot sync.
    await expect(diagnose(`invalid/${schema}.prisma`)).rejects.toThrow(message);
  });

  it("accepts every valid fixture, including optional and multi-path ownership graphs", async () => {
    // Regression: a diagnostic that grows too strict and rejects schemas the generator supports.
    for (const schema of await fs.readdir(schemaPath("valid"))) {
      await expect(diagnose(`valid/${schema}`)).resolves.toBeUndefined();
    }
  });

  it("surfaces a rejection through the real `prisma generate` command", async () => {
    // Regression: the generator process swallowing a validation error and exiting 0.
    const run = execa("pnpm", [
      "exec",
      "prisma",
      "generate",
      "--schema",
      schemaPath("invalid/missing-changelog.prisma"),
    ]);

    await expect(run).rejects.toThrow(`A "Changelog" model is required when "outboxSync" is enabled.`);
  }, 60000);
});
