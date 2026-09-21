// Adapted from Prisma ORM's SQL contract config helpers.
// These helpers are fully family-agnostic — they wrap any Contract object
// in a ContractSourceProvider that the Prisma CLI config loader understands.
import { pathToFileURL } from "node:url";
import type { ContractConfig, PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { defineConfig as coreDefineConfig } from "@prisma/orm-framework/config/config-types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { ok } from "@prisma/orm-framework/utils/result";
import { extname } from "pathe";

// Re-export defineConfig so users only need @prisma-idb/family-idb.
export { type PrismaNextConfig };
export const defineConfig = coreDefineConfig;

function defaultOutputFromContractPath(contractPath: string): string {
  const ext = extname(contractPath);
  if (ext.length === 0) return `${contractPath}.json`;
  return `${contractPath.slice(0, -ext.length)}.json`;
}

/**
 * Wraps an in-memory contract object for use in `prisma.config.ts`.
 *
 * Use this with the no-emit (TypeScript-first) workflow per ADR 006.
 *
 * @example
 * ```ts
 * import { typescriptContract } from '@prisma-idb/family-idb/config-types';
 * import contract from './prisma/contract';
 *
 * export default {
 *   family: idbFamily,
 *   target: idbTarget,
 *   contract: typescriptContract(contract, 'src/prisma/contract.json'),
 * };
 * ```
 */
export function typescriptContract(contract: Contract, output?: string): ContractConfig {
  return {
    source: {
      load: async () => ok(contract),
    },
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * Loads a contract from a TypeScript file at `contractPath` and wraps it for
 * use in `prisma.config.ts`. The file must export the contract as
 * `default` or `contract`.
 *
 * @example
 * ```ts
 * export default {
 *   contract: typescriptContractFromPath('./prisma/contract.ts'),
 * };
 * ```
 */
export function typescriptContractFromPath(contractPath: string, output?: string): ContractConfig {
  return {
    source: {
      inputs: [contractPath],
      load: async (context) => {
        const [absolutePath] = context.resolvedInputs;
        if (absolutePath === undefined) {
          throw new Error(
            "typescriptContractFromPath: context.resolvedInputs is empty. The CLI config loader should populate it positional-matched with source.inputs."
          );
        }
        const mod = await import(pathToFileURL(absolutePath).href);
        const contract: Contract | undefined = mod.default ?? mod.contract;
        if (contract === undefined) {
          throw new Error(
            `typescriptContractFromPath: module at "${absolutePath}" has no "default" or "contract" export.`
          );
        }
        return ok(contract);
      },
    },
    output: output ?? defaultOutputFromContractPath(contractPath),
  };
}
