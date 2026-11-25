import { readFile } from "node:fs/promises";
import type { ContractConfig } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable, mapPslDiagnostics } from "@prisma/orm-framework/psl-parser";
import { withSeedDiagnostics } from "@prisma/orm-framework/psl-parser/interpret";
import type { PslInterpretCapable, PslInterpretInput } from "@prisma/orm-framework/psl-parser/interpret";
import { FieldAttributeAst, ModelAttributeAst, parse, SyntaxNode } from "@prisma/orm-framework/psl-parser/syntax";
import { notOk } from "@prisma/orm-framework/utils/result";
import { extname, basename } from "pathe";
import type { ContractProjection } from "./psl-interpreter";
import { interpretPslDocumentToIdbContract } from "./psl-interpreter";
import { IDB_EXCLUDE_ATTR } from "./psl-binder";

/**
 * Removes `@idb.exclude`/`@@idb.exclude` from a PSL schema, so another
 * family's parser can read a schema written for family-idb. The SQL family,
 * for example, rejects the `idb` namespace it doesn't know
 * (`PSL_EXTENSION_NAMESPACE_NOT_COMPOSED`), and the server wants every field
 * these attributes hide from the client.
 *
 * It finds the attributes in the parser's syntax tree, so text that only
 * looks like one, such as `@idb.exclude` inside a string default or a
 * comment, is left alone. The tree keeps every attribute, including those on
 * a model the symbol table drops (a duplicate model name, or a block the
 * parser recovered from). Other attributes, `@ignore` and `@@ignore`
 * included, stay as written.
 */
export function stripIdbExcludeAttributes(schema: string): string {
  const { document } = parse(schema, "schema.prisma");
  // Node offsets are UTF-16 string indices, so they slice correctly after non-ASCII text.
  const cuts: { start: number; end: number }[] = [];
  for (const element of document.syntax.descendants()) {
    if (!(element instanceof SyntaxNode)) continue;
    const attribute = FieldAttributeAst.cast(element) ?? ModelAttributeAst.cast(element);
    const name = attribute?.name();
    if (!name || name.path().join(".") !== IDB_EXCLUDE_ATTR) continue;
    // A recovered name or argument list can contain tokens from adjacent attributes.
    const writtenName = schema.slice(name.syntax.offset, name.syntax.endOffset).replace(/\s/gu, "");
    if (writtenName !== IDB_EXCLUDE_ATTR) continue;
    const args = attribute?.argList();
    if (args && schema.slice(args.syntax.offset, args.syntax.endOffset).replace(/\s/gu, "") !== "()") continue;
    cuts.push(cutFor(schema, element.offset, element.endOffset));
  }
  // One pass over the cuts in source order; a cut that overlaps the previous one only extends it.
  let result = "";
  let cursor = 0;
  for (const { start, end } of cuts.sort((a, b) => a.start - b.start)) {
    if (start > cursor) result += schema.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return result + schema.slice(cursor);
}

/** The text to remove for one attribute at `[start, end)`, so the line around it stays well formed. */
function cutFor(schema: string, start: number, end: number): { start: number; end: number } {
  const lineStart = Math.max(schema.lastIndexOf("\n", start - 1), schema.lastIndexOf("\r", start - 1)) + 1;
  const carriageReturn = schema.indexOf("\r", end);
  const lineFeed = schema.indexOf("\n", end);
  const lineEnd = Math.min(
    carriageReturn === -1 ? schema.length : carriageReturn,
    lineFeed === -1 ? schema.length : lineFeed
  );
  const before = schema.slice(lineStart, start);
  const after = schema.slice(end, lineEnd);
  if (before.trim() === "" && after.trim() === "") {
    const lineBreakLength = schema.startsWith("\r\n", lineEnd) ? 2 : 1;
    return { start: lineStart, end: Math.min(schema.length, lineEnd + lineBreakLength) };
  }
  if (before.trim() === "") {
    // Keep the indentation for any following attribute or comment.
    return { start, end: end + (after.length - after.trimStart().length) };
  }
  // After a field or another attribute: drop it and the spaces before it.
  return { start: start - (before.length - before.trimEnd().length), end };
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
