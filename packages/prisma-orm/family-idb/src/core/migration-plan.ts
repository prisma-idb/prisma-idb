import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Contract } from "@prisma/orm-framework/contract/types";
import type { IdbMigrationPlanWithAuthoring } from "@prisma-idb/target-idb/migration";
import {
  IdbMigrationPlanner,
  contractToIdbSchema,
  deletedDataWarning,
  renderMigrationTs,
} from "@prisma-idb/target-idb/migration";
import { keepInternalSpecifiers } from "@prisma/orm-framework/components/emission";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { formatMigrationDirName } from "@prisma/orm-toolchain/migration-tools/io";
import { deriveProvidedInvariants } from "@prisma/orm-toolchain/migration-tools/invariants";
import { join, relative } from "pathe";
import { chainOrderByMetadata } from "./chain-order";

export interface MigrationPlanOptions {
  readonly migrationsDir: string;
  readonly contractPath: string;
  /**
   * Directory slug. Defaults to `"baseline"` when this turns out to be a
   * fresh (greenfield) space. **Required** when a prior migration package
   * is found (incremental mode) — this function returns exit code 2 if
   * omitted in that case, since which mode applies isn't known until the
   * on-disk chain has been inspected.
   */
  readonly name?: string;
  /** Contract-space identifier. Defaults to `"app"`. See ADR 212. */
  readonly spaceId?: string;
  /** Output sinks. Default to `process.stdout`/`process.stderr` so every
   *  existing caller (commander bin, tests) is unaffected; a CLI-engine
   *  command handler passes collecting sinks instead so nothing reaches
   *  the real stdout/stderr streams. */
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/**
 * Plans the next migration package for an IDB project, auto-detecting
 * whether this is the first ("greenfield"/baseline, `from: null`) or an
 * incremental migration (diffed against the current head) by checking
 * whether `<migrationsDir>/app/` (or `<migrationsDir>/` for an extension
 * space) already contains any migration packages.
 *
 * This mirrors `prisma-idb migration plan`'s job — one command instead of
 * a baseline/incremental split the caller has to pick correctly — but
 * *not* its `from: null`-unless-ref default: that default exists there
 * because a server database's on-disk chain can diverge from a live, separately
 * migrated database (tracked via the `db` ref and advanced by migration apply).
 * IDB has no such divergence — there is no
 * `db update`/`migrate` step on the Node side at all (`db init`/`db
 * update`/`db verify` are refusal-only for IDB), so the on-disk chain is
 * the only state that will ever exist; the browser runtime applies it
 * wholesale at open time. Trusting the on-disk chain as the auto-detected
 * `from` is therefore the safety-equivalent of the framework's ref system
 * for this target, not a corner-cut.
 *
 * Exit codes: 0 on success; 1 on a planning/consistency failure; 2 if
 * `--name` was required (incremental mode) and not supplied.
 */
export async function migrationPlan(opts: MigrationPlanOptions): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(line));
  const err = opts.err ?? ((line: string) => process.stderr.write(line));
  const spaceId = opts.spaceId ?? "app";
  if (spaceId === "snapshots") {
    err('migration plan: spaceId "snapshots" is reserved for the contract-snapshot store and cannot be used.\n');
    return 1;
  }
  const isAppSpace = spaceId === "app";
  const targetDir = isAppSpace ? join(opts.migrationsDir, "app") : opts.migrationsDir;
  // Relative-to-cwd display path — reflects wherever `migrationsDir` actually
  // resolved to (config-driven, an override, or the framework convention),
  // not a hardcoded "migrations/..." literal that would go stale for any
  // project not using the default layout.
  const dirLabel = `${relative(process.cwd(), targetDir)}/`;

  let existingDirs: string[] = [];
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    existingDirs = entries
      .filter((e) => e.isDirectory())
      // `refs/` holds the pinned head ref, not a migration package. `app/`
      // is a sibling space's directory when an extension space happens to
      // share `migrationsDir` with the app space (non-standard, but
      // defensive here — see ADR 212). `snapshots/` is the shared
      // content-addressed contract store (ADR 240) — an extension space's
      // targetDir is migrationsDir itself, so the store sits as a sibling
      // of its migration package dirs and must not be mistaken for one.
      .filter((e) => e.name !== "refs" && e.name !== "app" && e.name !== "snapshots")
      .map((e) => e.name);
  } catch (err_) {
    if ((err_ as NodeJS.ErrnoException).code !== "ENOENT") throw err_;
    // targetDir doesn't exist yet — expected for a fresh project.
  }

  const ctx: SharedCtx = { ...opts, out, err, spaceId, isAppSpace, targetDir, dirLabel };

  if (existingDirs.length === 0) {
    err(
      `migration plan: no existing migrations found under ${dirLabel} — generating a full baseline.\n` +
        "If you expected an incremental migration, check --migrations-dir / your config's migrations.dir.\n"
    );
    return planGreenfield(ctx);
  }

  return planIncremental(ctx, existingDirs);
}

interface SharedCtx extends MigrationPlanOptions {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly spaceId: string;
  readonly isAppSpace: boolean;
  readonly targetDir: string;
  readonly dirLabel: string;
}

async function planGreenfield(ctx: SharedCtx): Promise<number> {
  const name = ctx.name ?? "baseline";

  let contractRaw: string;
  let contractJson: unknown;
  try {
    contractRaw = await readFile(ctx.contractPath, "utf-8");
    contractJson = JSON.parse(contractRaw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      ctx.err(
        `migration plan: contract.json not found at ${ctx.contractPath}.\n` +
          "Run `prisma contract emit` first to generate the contract file.\n"
      );
      return 1;
    }
    throw err;
  }

  const planner = new IdbMigrationPlanner();
  const planResult = planner.plan({
    contract: contractJson,
    schema: null,
    policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
    fromContract: null,
    frameworkComponents: [],
    spaceId: ctx.spaceId,
  });

  if (planResult.kind === "failure") {
    ctx.err(
      "migration plan: migration planning failed:\n" +
        planResult.conflicts.map((c) => `  ${c.summary}`).join("\n") +
        "\n"
    );
    return 1;
  }

  const plan = planResult.plan as IdbMigrationPlanWithAuthoring;
  // The planner unconditionally prepends `_prisma_next_marker` creation for
  // `fromContract: null`, regardless of spaceId — the app space's own
  // baseline creates that store; an extension space applying its DDL in
  // the same combined transaction (ADR 011) must not try to recreate it.
  const ops = ctx.isAppSpace
    ? plan.operations
    : plan.operations.filter(
        (op) => !(op.kind === "createObjectStore" && (op as { storeName?: string }).storeName === "_prisma_next_marker")
      );
  const toHash = plan.destination.storageHash;

  const timestamp = new Date();
  const dirName = formatMigrationDirName(timestamp, name);
  const providedInvariants = Array.from(deriveProvidedInvariants(ops));
  const baseMetadata = {
    from: null as string | null,
    to: toHash,
    providedInvariants,
    createdAt: timestamp.toISOString(),
  };
  const migrationHash = computeMigrationHash(
    baseMetadata,
    ops as unknown as Parameters<typeof computeMigrationHash>[1]
  );
  const metadata = { ...baseMetadata, migrationHash };

  await writeMigrationPackage(ctx, {
    dirName,
    ops,
    metadata,
    migrationTsContent: renderMigrationTs({ fromHash: null, toHash, ops }),
    contractRaw,
    providedInvariants,
    fromLabel: "null  (fresh database — creates all stores from scratch)",
    toHash,
    logVerb: "Generated baseline migration",
  });

  return 0;
}

async function planIncremental(ctx: SharedCtx, existingDirs: readonly string[]): Promise<number> {
  if (ctx.name === undefined) {
    ctx.err("migration plan: --name <slug> is required when generating an incremental migration.\n");
    return 2;
  }

  const packages = new Map<string, { dirName: string; metadata: { from: string | null; to: string } }>();
  for (const dirName of existingDirs) {
    const metaPath = join(ctx.targetDir, dirName, "migration.json");
    let metaRaw: string;
    try {
      metaRaw = await readFile(metaPath, "utf-8");
    } catch (err) {
      ctx.err(`migration plan: cannot read ${metaPath} — ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    let meta: { from: string | null; to: string };
    try {
      meta = JSON.parse(metaRaw) as { from: string | null; to: string };
    } catch (err) {
      ctx.err(`migration plan: malformed ${metaPath} — ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    packages.set(dirName, { dirName, metadata: meta });
  }

  let ordered: { dirName: string; metadata: { from: string | null; to: string } }[];
  try {
    ordered = chainOrderByMetadata(packages);
  } catch (err) {
    ctx.err(`migration plan: migration chain is broken — ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const head = ordered[ordered.length - 1];
  if (head === undefined) {
    ctx.err("migration plan: no valid migration packages could be read.\n");
    return 1;
  }

  const headSnapshotPath = join(ctx.migrationsDir, "snapshots", head.metadata.to, "contract.json");
  let fromContractJson: unknown;
  try {
    const fromContractRaw = await readFile(headSnapshotPath, "utf-8");
    fromContractJson = JSON.parse(fromContractRaw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      ctx.err(
        `migration plan: head migration ${head.dirName} is inconsistent.\n` +
          `  migration.json claims to: ${head.metadata.to}\n` +
          `  but no store entry exists at ${relative(process.cwd(), headSnapshotPath)}\n` +
          "Regenerate the chain, or restore migrations/snapshots/ from source control.\n"
      );
      return 1;
    }
    throw err;
  }

  let contractRaw: string;
  let contractJson: unknown;
  try {
    contractRaw = await readFile(ctx.contractPath, "utf-8");
    contractJson = JSON.parse(contractRaw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      ctx.err(
        `migration plan: contract.json not found at ${ctx.contractPath}.\n` +
          "Run `prisma contract emit` first to generate the contract file.\n"
      );
      return 1;
    }
    throw err;
  }

  // fromContract is never null here, so the planner never prepends the
  // _prisma_next_marker op — no stripping needed, unlike the greenfield path.
  const fromSchema = contractToIdbSchema(fromContractJson);
  const planner = new IdbMigrationPlanner();
  const planResult = planner.plan({
    contract: contractJson,
    schema: fromSchema,
    policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
    fromContract: fromContractJson as Contract,
    frameworkComponents: [],
    spaceId: ctx.spaceId,
  });

  if (planResult.kind === "failure") {
    ctx.err(
      "migration plan: migration planning failed:\n" +
        planResult.conflicts.map((c) => `  ${c.summary}`).join("\n") +
        "\n"
    );
    return 1;
  }

  const plan = planResult.plan as IdbMigrationPlanWithAuthoring;
  const ops = plan.operations;
  const fromHash = head.metadata.to;
  const toHash = plan.destination.storageHash;

  if (fromHash === toHash) {
    ctx.out("migration plan: contract is unchanged since the last migration — nothing to do.\n");
    return 0;
  }

  const timestamp = new Date();
  const dirName = formatMigrationDirName(timestamp, ctx.name);
  const providedInvariants = Array.from(deriveProvidedInvariants(ops));
  const baseMetadata = { from: fromHash, to: toHash, providedInvariants, createdAt: timestamp.toISOString() };
  const migrationHash = computeMigrationHash(
    baseMetadata,
    ops as unknown as Parameters<typeof computeMigrationHash>[1]
  );
  const metadata = { ...baseMetadata, migrationHash };

  await writeMigrationPackage(ctx, {
    dirName,
    ops,
    metadata,
    migrationTsContent: plan.renderTypeScript(keepInternalSpecifiers),
    contractRaw,
    providedInvariants,
    fromLabel: fromHash,
    toHash,
    logVerb: "Generated migration",
  });
  warnAboutDeletedData(ctx, ops);

  return 0;
}

/** Warns on stderr when the migration drops a store; see {@link deletedDataWarning}. */
function warnAboutDeletedData(ctx: SharedCtx, ops: readonly unknown[]): void {
  const warning = deletedDataWarning(ops);
  if (warning !== undefined) ctx.err(warning);
}

interface WritePackageInput {
  readonly dirName: string;
  readonly ops: readonly unknown[];
  readonly metadata: { readonly from: string | null; readonly to: string; readonly migrationHash: string };
  readonly migrationTsContent: string;
  readonly contractRaw: string;
  readonly providedInvariants: readonly string[];
  readonly fromLabel: string;
  readonly toHash: string;
  readonly logVerb: string;
}

async function writeMigrationPackage(ctx: SharedCtx, input: WritePackageInput): Promise<void> {
  const packageDir = join(ctx.targetDir, input.dirName);
  await mkdir(packageDir, { recursive: true });

  await writeFile(join(packageDir, "ops.json"), JSON.stringify(input.ops, null, 2), "utf-8");
  await writeFile(join(packageDir, "migration.json"), JSON.stringify(input.metadata, null, 2), "utf-8");
  await writeFile(join(packageDir, "migration.ts"), input.migrationTsContent, "utf-8");

  const contractDtsPath = ctx.contractPath.replace(/\.json$/i, ".d.ts");
  await writeContractSnapshot(ctx.migrationsDir, input.toHash, input.contractRaw, contractDtsPath, ctx.err);

  let extensionSpaceNote = "";
  if (!ctx.isAppSpace) {
    const refsDir = join(ctx.migrationsDir, "refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(
      join(refsDir, "head.json"),
      JSON.stringify({ hash: input.toHash, invariants: input.providedInvariants }, null, 2),
      "utf-8"
    );
    extensionSpaceNote =
      `\nAlso pinned migrations/refs/head.json → ${input.toHash}\n` +
      "exports/control.ts already JSON-imports migrations/refs/head.json, so it will pick up the new head " +
      `automatically — just make sure it also imports the new migration package (migrations/${input.dirName}).\n`;
  }

  ctx.out(
    `${input.logVerb} at ${ctx.dirLabel}${input.dirName}\n` +
      `  from: ${input.fromLabel}\n` +
      `  to:   ${input.toHash}\n` +
      `  ops:  ${input.ops.length} operation${input.ops.length === 1 ? "" : "s"}\n` +
      (ctx.isAppSpace
        ? "\nNext: run `prisma-idb migration contract-space` to bundle into contract-space.generated.ts\n"
        : extensionSpaceNote)
  );
}

/**
 * Writes a contract snapshot into the shared content-addressed store at
 * `<migrationsDir>/snapshots/<hash>/` (ADR 240). Write-if-absent on
 * `contract.json`: our contract emission is deterministic (the hash is
 * derived from these same bytes), so an existing `contract.json` for `hash`
 * is trusted as-is without a byte comparison. A first write goes to a temp
 * directory then renames into place, so a concurrent or interrupted write
 * can't leave a partial entry visible under its real hash.
 *
 * Both `contract.json` and `contract.d.ts` are written for layout parity
 * with the Postgres side's real, vendor-CLI-produced store — nothing in
 * this package reads the `.d.ts` back today; only `contract.json` is a read
 * dependency for the next `migration plan`. If an earlier run left an entry
 * with only `contract.json` (the source `.d.ts` didn't exist yet at the
 * time), a later call for the same hash backfills `contract.d.ts` in place
 * instead of leaving the entry permanently partial.
 */
async function writeContractSnapshot(
  migrationsDir: string,
  hash: string,
  contractRaw: string,
  contractDtsPath: string,
  err: (line: string) => void
): Promise<void> {
  const snapshotsDir = join(migrationsDir, "snapshots");
  const entryDir = join(snapshotsDir, hash);

  try {
    await readFile(join(entryDir, "contract.json"), "utf-8");
    // contract.json (the read dependency) is already present — write-if-absent.
    // Still backfill contract.d.ts if an earlier run skipped it (source .d.ts
    // didn't exist yet at the time), so the entry doesn't stay permanently
    // partial once a `contract emit` produces one.
    try {
      await readFile(join(entryDir, "contract.d.ts"), "utf-8");
    } catch (dtsCheckErr) {
      if ((dtsCheckErr as NodeJS.ErrnoException).code !== "ENOENT") throw dtsCheckErr;
      try {
        await copyFile(contractDtsPath, join(entryDir, "contract.d.ts"));
      } catch (dtsErr) {
        if ((dtsErr as NodeJS.ErrnoException).code !== "ENOENT") throw dtsErr;
      }
    }
    return;
  } catch (err_) {
    if ((err_ as NodeJS.ErrnoException).code !== "ENOENT") throw err_;
  }

  const tmpDir = join(snapshotsDir, `.tmp-${randomBytes(8).toString("hex")}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    await writeFile(join(tmpDir, "contract.json"), contractRaw, "utf-8");
    try {
      await copyFile(contractDtsPath, join(tmpDir, "contract.d.ts"));
    } catch (dtsErr) {
      if ((dtsErr as NodeJS.ErrnoException).code !== "ENOENT") throw dtsErr;
      err(
        `Warning: contract.d.ts not found at ${contractDtsPath}.\n` +
          "The snapshot store entry will hold only contract.json.\n" +
          "Run `prisma contract emit` first, then re-run this command.\n\n"
      );
    }
    await rename(tmpDir, entryDir);
  } catch (writeErr) {
    await rm(tmpDir, { recursive: true, force: true });
    throw writeErr;
  }
}
