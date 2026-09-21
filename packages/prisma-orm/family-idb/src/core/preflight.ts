import { readdir, readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import type { MigrationMetadata } from "@prisma/orm-toolchain/migration-tools/metadata";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { chainOrderByMetadata, type ChainablePackage } from "./chain-order";
import { applyOneDdlOp, isIdbDdlOp, type IdbDdlOp } from "@prisma-idb/target-idb/migration";
import { join } from "pathe";

export interface PreflightOptions {
  readonly migrationsDir: string;
  /** Output sinks. Default to `process.stdout`/`process.stderr`. */
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/**
 * Walk every migration package under `<migrationsDir>/app/` in chain order,
 * applying each package's `ops.json` against a fresh `fake-indexeddb`
 * instance inside an `upgradeneeded` callback. Reports per-step status to
 * stdout and the final outcome via exit code.
 *
 * **Why this exists**: a dedicated preflight command avoids three failure modes
 * of inlining this into `db update`: (a) `fake-indexeddb` disagrees with real
 * browsers on some edge cases and is not a reliable production oracle; (b) it
 * would substitute a runtime check for proper test coverage; (c) it would ship
 * a test-only package on a production path. Running it in CI gives the gate
 * without the workflow tax on every author.
 *
 * **Scope vs runtime**: this command catches "the chain doesn't apply
 * cleanly" — a structural issue. It does NOT catch "the chain produces
 * the wrong schema" (that's `verifySchema` against the head's contract,
 * resolvable via `migrations/snapshots/<hash>/contract.json` since Phase
 * 8.9 — still deferred to a follow-up).
 *
 * Exit codes: 0 on full chain success; 1 on any failure.
 */
export async function runPreflight(opts: PreflightOptions): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(line));
  const err = opts.err ?? ((line: string) => process.stderr.write(line));
  const migrationsDir = opts.migrationsDir;
  const appDir = join(migrationsDir, "app");

  const packages = await loadPackages(appDir);
  if (packages.length === 0) {
    out("No migration packages found. Nothing to preflight.\n");
    return 0;
  }

  out(`Preflighting ${packages.length} migration(s) against fake-indexeddb…\n`);

  const factory = new IDBFactory();
  const dbName = "__preflight__";

  let currentVersion = 0;
  for (const pkg of packages) {
    out(`  ${pkg.dirName} … `);
    try {
      currentVersion += 1;
      await applyPackage({ factory, dbName, targetVersion: currentVersion, ops: pkg.ops });
      out("ok\n");
    } catch (applyErr) {
      out("FAILED\n");
      err(`    ${applyErr instanceof Error ? applyErr.message : String(applyErr)}\n`);
      err("\nPreflight failed.\n");
      return 1;
    }
  }

  out("\nPreflight passed: every migration in the chain applies cleanly.\n");
  return 0;
}

interface LoadedPackage extends ChainablePackage {
  readonly metadata: MigrationMetadata;
  readonly ops: readonly IdbDdlOp[];
}

async function loadPackages(appDir: string): Promise<LoadedPackage[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(appDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  // Load all packages unordered, then derive chain order by walking
  // metadata.from/to edges. Directory name sort is unreliable when
  // timestamp formats mix between hand-authored baselines and CLI-emitted
  // additions (e.g. T120000 vs T0337).
  const unordered = new Map<string, LoadedPackage>();
  for (const dirName of dirs) {
    const metaRaw = await readFile(join(appDir, dirName, "migration.json"), "utf-8");
    const opsRaw = await readFile(join(appDir, dirName, "ops.json"), "utf-8");
    const metadata = JSON.parse(metaRaw) as MigrationMetadata;
    const opsParsed = JSON.parse(opsRaw) as unknown[];
    const ops: IdbDdlOp[] = [];
    for (const op of opsParsed) {
      if (!isIdbDdlOp(op as never)) {
        throw new Error(`Non-IDB op found in ${dirName}/ops.json: ${JSON.stringify(op)}`);
      }
      ops.push(op as IdbDdlOp);
    }
    const computedHash = computeMigrationHash(metadata, ops as unknown as Parameters<typeof computeMigrationHash>[1]);
    if (computedHash !== metadata.migrationHash) {
      throw new Error(
        `Migration hash mismatch in ${dirName}: stored migrationHash ${metadata.migrationHash} ` +
          `does not match computed hash ${computedHash}`
      );
    }
    unordered.set(dirName, { dirName, metadata, ops });
  }

  return chainOrderByMetadata(unordered);
}

function applyPackage(input: {
  readonly factory: IDBFactory;
  readonly dbName: string;
  readonly targetVersion: number;
  readonly ops: readonly IdbDdlOp[];
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = input.factory.open(input.dbName, input.targetVersion);
    req.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      const db = target.result;
      const tx = target.transaction;
      if (tx === null) {
        reject(new Error("upgradeneeded fired with null version-change transaction"));
        return;
      }
      try {
        for (const op of input.ops) {
          applyOneDdlOp(db, tx, op);
        }
      } catch (err) {
        reject(err);
      }
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error ?? new Error("preflight open request failed"));
  });
}
