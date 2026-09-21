import type { PrismaNextConfig } from "@prisma/orm-toolchain/config-loader";
import { finalizeConfig } from "@prisma/orm-toolchain/config-loader";
import type {
  ArgsSpec,
  CommandDefinition,
  FlagSpec,
  Handler,
  HelpSpec,
  PositionalSpec,
  SpawnDeclarations,
} from "@prisma/cli-engine";
import { defineCommand } from "@prisma/cli-engine";
import { CliStructuredError, notOk } from "@prisma/cli-engine/protocol";
import { ormConfigSection } from "./config-section";

function normalizeError(error: unknown): CliStructuredError {
  if (CliStructuredError.is(error)) return error;
  return new CliStructuredError("IDB-CLI.UNEXPECTED_ERROR", error instanceof Error ? error.message : String(error));
}

function finalizedConfigContext<TCtx extends { readonly cwd: string; readonly config: unknown }>(ctx: TCtx): TCtx {
  if (ctx.config === undefined) return ctx;
  return { ...ctx, config: finalizeConfig(ctx.config as PrismaNextConfig, ctx.cwd) };
}

/**
 * These 3 commands are IDB-specific (fake-indexeddb, IdbMigrationPlanner) —
 * pointing them at a non-IDB `prisma.config.ts` would fail confusingly deep
 * inside that logic rather than with a clear, actionable error. `orm`'s own
 * config section is family-agnostic by design (ADR 150), so this guard is
 * this shell's responsibility, not the section's.
 */
function requireIdbFamily(config: PrismaNextConfig): void {
  const familyId = config.family?.familyId;
  if (familyId !== "idb") {
    throw new CliStructuredError(
      "IDB-CLI.FAMILY_MISMATCH",
      `config family is "${familyId ?? "unknown"}", expected "idb".`,
      {
        why: "This CLI's migration commands operate on IDB-family projects only.",
        nextActions: [
          {
            kind: "edit-file",
            label:
              "Point --config at your browser-side prisma.config.ts (the one using @prisma-idb/family-idb/control)",
          },
        ],
      }
    );
  }
}

/**
 * `defineCommand` pre-bound to the `orm` config section (see
 * `config-section.ts`) with a uniform error boundary and path
 * finalization, mirroring `@prisma/orm-toolchain`'s own `defineOrmCommand`
 * (`vendor/prisma/packages/1-framework/3-tooling/cli/src/orm/define-command.ts`):
 * the engine's config loader hands a command `contract.output`/
 * `migrations.dir` exactly as authored (usually relative); finalizing here,
 * once, means handlers always read absolute paths.
 */
export function defineIdbCommand<
  TFlags extends Record<string, FlagSpec<unknown>> = Record<never, FlagSpec<unknown>>,
  TPositionals extends Record<string, PositionalSpec<unknown>> = Record<never, PositionalSpec<unknown>>,
  TCode extends number = never,
>(
  def: {
    readonly help: HelpSpec;
    readonly args?: ArgsSpec<TFlags, TPositionals>;
    readonly exitCodes?: Readonly<Record<TCode, string>>;
    readonly handler: Handler<TFlags, TPositionals, PrismaNextConfig, TCode, false, false>;
  } & SpawnDeclarations
): CommandDefinition<TFlags, TPositionals, PrismaNextConfig, TCode, false, false> {
  return defineCommand<TFlags, TPositionals, PrismaNextConfig, TCode, false, false>({
    ...def,
    needs: { config: ormConfigSection },
    handler: async (args, ctx) => {
      try {
        const finalized = finalizedConfigContext(ctx);
        requireIdbFamily(finalized.config);
        return await def.handler(args, finalized);
      } catch (error) {
        return notOk(normalizeError(error));
      }
    },
  });
}
