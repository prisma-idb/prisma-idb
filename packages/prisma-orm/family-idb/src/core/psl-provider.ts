import { readFile } from "node:fs/promises";
import type { ContractConfig, ContractSourceDiagnostic } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable, rangeToPslSpan } from "@prisma/orm-framework/psl-parser";
import { withSeedDiagnostics } from "@prisma/orm-framework/psl-parser/interpret";
import type { ParseDiagnostic, SourceFile } from "@prisma/orm-framework/psl-parser/syntax";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { notOk } from "@prisma/orm-framework/utils/result";
import { extname, basename } from "pathe";
import type { ContractProjection } from "./psl-interpreter";
import { interpretPslDocumentToIdbContract } from "./psl-interpreter";

/**
 * Removes `@idb.exclude`/`@@idb.exclude` from raw PSL text — the `idb`
 * namespace family-idb owns (`psl-interpreter.ts`'s `IDB_EXCLUDE_ATTR`).
 * A foreign PSL parser (e.g. the SQL family's) doesn't recognize this
 * namespace and hard-errors on it (`PSL_EXTENSION_NAMESPACE_NOT_COMPOSED`);
 * stripping it is the text-level equivalent of what family-idb itself
 * already does for these same fields under `projection: "full"`, where the
 * attribute is documented as a no-op. Use this when sharing a schema.prisma
 * authored for family-idb with a different family's schema loader — the
 * server always wants every field these attributes would otherwise hide
 * from the client.
 */
export function stripIdbExcludeAttributes(schema: string): string {
  return schema
    .replace(/^[ \t]*@@idb\.exclude\b.*\n?/gm, "") // model-level: drop the whole line, incl. trailing comments
    .replace(/[ \t]*@idb\.exclude\b/g, ""); // field-level: drop just the token, keep the field
}

function defaultOutputFromSchemaPath(schemaPath: string): string {
  const ext = extname(schemaPath);
  if (ext.length === 0) return `${schemaPath}.json`;
  const base = schemaPath.slice(0, -ext.length);
  if (basename(base) === "schema") {
    return `${base.slice(0, -"schema".length)}contract.json`;
  }
  return `${base}.json`;
}

function mapParseDiagnostics(
  diagnostics: readonly ParseDiagnostic[],
  sourceFile: SourceFile,
  sourceId: string
): ContractSourceDiagnostic[] {
  return diagnostics.map((d) => ({
    code: d.code as string,
    message: d.message,
    sourceId,
    span: rangeToPslSpan(d.range, sourceFile),
  }));
}

export interface PrismaIdbContractOptions {
  readonly output?: string;
  /**
   * `"client"` projects out anything marked `@idb.exclude`/`@@idb.exclude`
   * (ADR 012). Pass a distinct `output` alongside this so the client and
   * full/server contracts don't collide on the same file.
   * @default "full"
   */
  readonly projection?: ContractProjection;
  /**
   * Runs on the raw schema text right after it's read, before parsing.
   * Lets a downstream package (e.g. `@prisma-idb/sync-server`) append
   * synthetic model/enum declarations — the appended text goes through the
   * exact same parse → interpret → hash pipeline as hand-authored PSL, so
   * `storageHash` reflects it correctly (it's computed *inside*
   * `interpretPslDocumentToIdbContract`, from whatever this returns).
   */
  readonly injectSchemaText?: (schema: string) => string;
}

/**
 * Creates a `ContractConfig` that reads an IDB schema from a `.prisma` file.
 *
 * Use this in `prisma.config.ts` as the `contract:` value when you prefer
 * PSL authoring over the TypeScript-first `defineContract()` helper.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@prisma-idb/family-idb/config-types';
 * import { prismaIdbContract } from '@prisma-idb/family-idb/contract-psl';
 *
 * export default defineConfig({
 *   // ...
 *   contract: prismaIdbContract('./src/prisma/schema.prisma'),
 * });
 * ```
 *
 * The emitted `contract.json` lands next to the schema file by default
 * (`schema.prisma` → `contract.json`). Override with `options.output`.
 */
export function prismaIdbContract(schemaPath: string, options?: PrismaIdbContractOptions): ContractConfig {
  return {
    source: {
      inputs: [schemaPath],
      load: async (context) => {
        const [absoluteSchemaPath] = context.resolvedInputs;
        if (absoluteSchemaPath === undefined) {
          throw new Error(
            "prismaIdbContract: context.resolvedInputs is empty. The CLI config loader should populate it positional-matched with source.inputs."
          );
        }

        let schema: string;
        try {
          schema = await readFile(absoluteSchemaPath, "utf-8");
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

        if (options?.injectSchemaText) {
          schema = options.injectSchemaText(schema);
        }

        const { document, sourceFile, diagnostics: parseDiagnostics } = parse(schema);
        const { table, diagnostics: symbolDiagnostics } = buildSymbolTable({
          document,
          sourceFile,
          pslBlockDescriptors: {},
        });

        // Do not short-circuit on provider-level diagnostics — the fault-tolerant
        // parser/symbol-table still produce a usable table, and the interpreter
        // may surface its own diagnostics in the same response.
        const seedDiagnostics = [
          ...mapParseDiagnostics(parseDiagnostics, sourceFile, schemaPath),
          ...mapParseDiagnostics(symbolDiagnostics, sourceFile, schemaPath),
        ];

        const interpreted = withSeedDiagnostics(
          interpretPslDocumentToIdbContract(
            table,
            schemaPath,
            options?.projection !== undefined ? { projection: options.projection } : undefined
          ),
          seedDiagnostics
        );
        // Return the full Result so seed diagnostics (parse + symbol-table
        // findings) survive the success path — the config loader surfaces
        // them alongside the contract.
        return interpreted;
      },
    },
    output: options?.output ?? defaultOutputFromSchemaPath(schemaPath),
  };
}
