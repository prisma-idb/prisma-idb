import { readFile } from "node:fs/promises";
import type { ContractConfig } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable, mapPslDiagnostics } from "@prisma/orm-framework/psl-parser";
import { withSeedDiagnostics } from "@prisma/orm-framework/psl-parser/interpret";
import type { PslInterpretCapable, PslInterpretInput } from "@prisma/orm-framework/psl-parser/interpret";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { notOk } from "@prisma/orm-framework/utils/result";
import { extname, basename } from "pathe";
import type { ContractProjection } from "./psl-interpreter";
import { interpretPslDocumentToIdbContract } from "./psl-interpreter";
import { IDB_EXCLUDE_ATTR } from "./psl-binder";

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
  // The parser locates each attribute, so text that only looks like one, such
  // as `@idb.exclude` inside a string default or a comment, is left alone.
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const spans: { start: number; end: number }[] = [];
  for (const namespace of Object.values(symbolTable.namespaces)) {
    for (const model of Object.values(namespace.models)) {
      const attributes = [...model.attributes, ...Object.values(model.fields).flatMap((field) => field.attributes)];
      for (const attribute of attributes) {
        if (attribute.name === IDB_EXCLUDE_ATTR) {
          spans.push({ start: attribute.span.start.offset, end: attribute.span.end.offset });
        }
      }
    }
  }
  // Cut from the end, so earlier offsets stay valid.
  let result = schema;
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    const lineStart = result.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = result.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? result.length : lineEndIndex;
    const before = result.slice(lineStart, start);
    const after = result.slice(end, lineEnd);
    if (before.trim() === "" && (after.trim() === "" || after.trim().startsWith("//"))) {
      // A model-level attribute alone on its line: drop the line, with any trailing comment.
      result = result.slice(0, lineStart) + result.slice(lineEndIndex === -1 ? lineEnd : lineEnd + 1);
    } else {
      // A field-level attribute: drop it and the spaces before it, and keep the field.
      const trimmedStart = start - (before.length - before.trimEnd().length);
      result = result.slice(0, trimmedStart) + result.slice(end);
    }
  }
  return result;
}

/** Place contract.json beside schema.prisma, or use the schema basename otherwise. */
function defaultOutputFromSchemaPath(schemaPath: string): string {
  const ext = extname(schemaPath);
  if (ext.length === 0) return `${schemaPath}.json`;
  const base = schemaPath.slice(0, -ext.length);
  if (basename(base) === "schema") {
    return `${base.slice(0, -"schema".length)}contract.json`;
  }
  return `${base}.json`;
}

/** Output, projection, and schema text hooks for the PSL contract provider. */
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
  /**
   * Share the family pipeline between disk loading and cached editor documents.
   * The interpreter binds IDB attributes with the family's own specs.
   */
  function interpret({ documents, symbolTable, sources }: Omit<PslInterpretInput, "binder">) {
    const [document] = documents;
    const sourceId = document === undefined ? schemaPath : sources.sourceFileFor(document.syntax).filename;
    return interpretPslDocumentToIdbContract(symbolTable, sourceId, {
      sources,
      ...(options?.projection !== undefined ? { projection: options.projection } : {}),
    });
  }

  const source: PslInterpretCapable = {
    format: "psl",
    interpret,
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

      // The filename becomes each diagnostic's `sourceId`, so pass the
      // configured schema path to keep diagnostics pointing at the user's file.
      const { document, sources, diagnostics: parseDiagnostics } = parse(schema, schemaPath);
      const { symbolTable: table, diagnostics: symbolDiagnostics } = buildSymbolTable({
        documents: [document],
        sources,
        defaultNamespaceId: context.defaultNamespaceId,
      });

      // Do not short-circuit on provider-level diagnostics — the fault-tolerant
      // parser/symbol-table still produce a usable table, and the interpreter
      // may surface its own diagnostics in the same response.
      const seedDiagnostics = [
        ...mapPslDiagnostics(parseDiagnostics, sources),
        ...mapPslDiagnostics(symbolDiagnostics, sources),
      ];

      const interpreted = withSeedDiagnostics(
        interpret({ documents: [document], symbolTable: table, sources }),
        seedDiagnostics
      );
      // Return the full Result so seed diagnostics (parse + symbol-table
      // findings) survive the success path — the config loader surfaces
      // them alongside the contract.
      return interpreted;
    },
  };
  return {
    source,
    output: options?.output ?? defaultOutputFromSchemaPath(schemaPath),
  };
}
