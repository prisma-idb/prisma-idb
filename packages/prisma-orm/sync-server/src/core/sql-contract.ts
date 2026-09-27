import { readFile } from "node:fs/promises";
import type { ContractConfig } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable, mapPslDiagnostics } from "@prisma/orm-framework/psl-parser";
import { hasPslInterpreter, withSeedDiagnostics } from "@prisma/orm-framework/psl-parser/interpret";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { notOk, ok } from "@prisma/orm-framework/utils/result";
import { applySqlSpecifierControlPolicy } from "@prisma/orm-family-sql/contract-ts/contract-builder";
import { prismaContract, type PrismaContractOptions } from "@prisma/orm-family-sql/contract-psl/provider";
import { prepareSqlSchemaWithSync } from "./changelog-schema";

/**
 * Reads `schemaPath` once, runs it through `prepareSqlSchemaWithSync`, and
 * hands the *text* straight to the SQL family's own parse → interpret →
 * control-policy pipeline — no generated `.prisma` file lands on disk.
 *
 * `@prisma/orm-family-sql`'s own `prismaContract(schemaPath, options)`
 * always `readFile()`s its argument, with no hook to inject text instead
 * (github.com/prisma/orm#30115). This works around that today by
 * decomposing it: call the real `prismaContract` to get a `source` whose
 * `interpret` is the target-specific closure we don't want to reimplement
 * (`options.target`, `options.createNamespace`, etc. all live there), then
 * replace only `load` with a version that transforms the schema text
 * in-memory instead of pointing at a second file. The transformed text
 * still flows through the same parse → symbol-table → interpret →
 * `applySqlSpecifierControlPolicy` steps `prismaContract` itself runs, so
 * `storageHash` and diagnostics behave identically to the file-based path.
 *
 * Note: `@prisma/orm-postgres/config`'s `defineConfig` (and its per-target
 * siblings) only accept a schema *path* for `contract`, not a
 * `ContractConfig` — they build their own `prismaContract(...)` call
 * internally. Passing this function's return value to one of those still
 * requires wiring the family/target/adapter/driver through the core
 * `defineConfig` (`@prisma/orm-framework/config/config-types`) directly
 * instead of the target's convenience wrapper.
 */
export function sqlContractWithSync(schemaPath: string, options: PrismaContractOptions): ContractConfig {
  const { source, output } = prismaContract(schemaPath, options);
  if (!hasPslInterpreter(source)) {
    throw new Error("sqlContractWithSync: prismaContract() did not return a PSL-capable source.");
  }
  const { interpret } = source;

  return {
    ...(output !== undefined ? { output } : {}),
    source: {
      ...source,
      async load(context) {
        const [absoluteSchemaPath] = context.resolvedInputs;
        if (absoluteSchemaPath === undefined) {
          throw new Error(
            "sqlContractWithSync: context.resolvedInputs is empty. The CLI config loader should populate it positional-matched with source.inputs."
          );
        }

        let raw: string;
        try {
          raw = await readFile(absoluteSchemaPath, "utf-8");
        } catch (error) {
          const message = String(error);
          return notOk({
            summary: `Failed to read Prisma schema at "${schemaPath}"`,
            diagnostics: [
              {
                code: "PSL_SCHEMA_READ_FAILED",
                message,
                sourceId: schemaPath,
              },
            ],
          });
        }

        const schema = prepareSqlSchemaWithSync(raw);

        const { document, sources, diagnostics: parseDiagnostics } = parse(schema, schemaPath);
        const documents = [document];
        const { symbolTable, diagnostics: symbolTableDiagnostics } = buildSymbolTable({
          documents,
          sources,
          pslBlockDescriptors: context.authoringContributions.pslBlockDescriptors,
        });

        const seedDiagnostics = mapPslDiagnostics([...parseDiagnostics, ...symbolTableDiagnostics], sources);

        const interpreted = withSeedDiagnostics(
          interpret({ documents, sources, symbolTable }, context),
          seedDiagnostics
        );
        if (!interpreted.ok) {
          return interpreted;
        }

        return ok(
          applySqlSpecifierControlPolicy(interpreted.value, options.defaultControlPolicy, options.createNamespace)
        );
      },
    },
  };
}
