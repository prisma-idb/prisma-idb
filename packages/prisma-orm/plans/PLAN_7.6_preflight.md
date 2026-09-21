# Phase 7.6 — `prisma-next-idb preflight`

**Status**: Not started
**Depends on**: 7.1, 7.3, 7.5 (CLI host)
**Blocks**: 7.7 (CI gate for the demo app's migrations)

## Goal

Add a CLI command that walks the migration chain from empty database
to the head ref, applying each package's `ops.json` against a fresh
`fake-indexeddb` factory inside `upgradeneeded`. This is the
authoritative "does this chain apply cleanly" check — the spec
explicitly references it as the replacement for the manifest dry-run
([FEEDBACKS.md:289-292](../FEEDBACKS.md#L289-L292)).

Per-step behaviour:

1. Start with an empty `fake-indexeddb` factory.
2. For each migration package in chain order (`null → A → B → C → ...`):
   - Open DB at `current_version + 1`.
   - Inside `upgradeneeded`, apply that package's `ops.json` in order.
   - Wait for `onsuccess`.
3. Reconstruct the final schema by introspecting the post-walk DB.
4. Report per-step success/failure, and the reconstructed schema vs.
   the `end-contract.json` of the head package.

Exit code 0 if every step applies; 1 if any step fails.

## Files to update

### `packages/prisma-orm/family-idb/src/bin/prisma-idb.ts` (existing from 7.5)

Add the `preflight` case:

```ts
case "preflight":
  return runPreflight({ cwd: process.cwd() });
```

### `packages/prisma-orm/family-idb/src/core/preflight.ts` (new)

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "pathe";
import { IDBFactory } from "fake-indexeddb";
import type { MigrationMetadata } from "@prisma-next/migration-tools/metadata";
import type { IdbDdlOp } from "@prisma-next-idb/target-idb/migration";
import { isIdbDdlOp } from "@prisma-next-idb/target-idb/migration";

export interface PreflightOptions {
  readonly cwd: string;
  readonly migrationsDir?: string;
}

export async function runPreflight(opts: PreflightOptions): Promise<number> {
  const migrationsDir = opts.migrationsDir ?? join(opts.cwd, "migrations");
  const appDir = join(migrationsDir, "app");

  const packages = await loadPackages(appDir);
  if (packages.length === 0) {
    console.log("No migration packages found. Nothing to preflight.");
    return 0;
  }

  console.log(`Preflighting ${packages.length} migration(s) against fake-indexeddb…`);

  const factory = new IDBFactory();
  const dbName = "__preflight__";

  let currentVersion = 0;
  let failed = false;

  for (const pkg of packages) {
    process.stdout.write(`  ${pkg.dirName} … `);
    try {
      currentVersion += 1;
      await applyPackage({
        factory,
        dbName,
        targetVersion: currentVersion,
        ops: pkg.ops,
      });
      process.stdout.write("ok\n");
    } catch (err) {
      process.stdout.write(`FAILED\n`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
      break;
    }
  }

  if (failed) {
    console.error("\nPreflight failed.");
    return 1;
  }

  console.log("\nPreflight passed: every migration in the chain applies cleanly.");
  return 0;
}

interface LoadedPackage {
  readonly dirName: string;
  readonly metadata: MigrationMetadata;
  readonly ops: readonly IdbDdlOp[];
}

async function loadPackages(appDir: string): Promise<LoadedPackage[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(appDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const packages: LoadedPackage[] = [];
  for (const dirName of dirs) {
    const metaRaw = await readFile(join(appDir, dirName, "migration.json"), "utf-8");
    const opsRaw = await readFile(join(appDir, dirName, "ops.json"), "utf-8");
    const metadata = JSON.parse(metaRaw) as MigrationMetadata;
    const opsParsed = JSON.parse(opsRaw) as unknown[];
    const ops: IdbDdlOp[] = [];
    for (const op of opsParsed) {
      if (!isIdbDdlOp(op as never)) {
        throw new Error(`Non-IDB op in ${dirName}/ops.json: ${JSON.stringify(op)}`);
      }
      ops.push(op as IdbDdlOp);
    }
    packages.push({ dirName, metadata, ops });
  }

  // Validate chain connectivity (same as codegen).
  let cursor: string | null = null;
  for (const pkg of packages) {
    if (pkg.metadata.from !== cursor) {
      throw new Error(
        `Chain broken at ${pkg.dirName}: expected from === ${JSON.stringify(cursor)}, got ${JSON.stringify(pkg.metadata.from)}`
      );
    }
    cursor = pkg.metadata.to;
  }

  return packages;
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
        reject(new Error("upgradeneeded fired with null transaction"));
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
    req.onerror = () => reject(req.error ?? new Error("preflight open failed"));
  });
}

function applyOneDdlOp(db: IDBDatabase, tx: IDBTransaction, op: IdbDdlOp): void {
  // Same body as target-idb/src/core/migration-runner.ts:applyOneDdlOp.
  // Consider extracting into a shared helper module in target-idb so
  // both runner and preflight import the same implementation — avoids
  // future drift between the two apply paths.
  switch (op.kind) {
    case "createObjectStore":
      db.createObjectStore(op.storeName, {
        keyPath: op.def.keyPath,
        ...(op.def.autoIncrement !== undefined && { autoIncrement: op.def.autoIncrement }),
      });
      return;
    case "dropObjectStore":
      db.deleteObjectStore(op.storeName);
      return;
    case "createIndex": {
      const store = tx.objectStore(op.storeName);
      store.createIndex(op.indexName, op.def.keyPath, {
        unique: op.def.unique,
        ...(op.def.multiEntry !== undefined && { multiEntry: op.def.multiEntry }),
      });
      return;
    }
    case "dropIndex": {
      const store = tx.objectStore(op.storeName);
      store.deleteIndex(op.indexName);
      return;
    }
  }
}
```

**Note**: `applyOneDdlOp` duplicates the function in
[migration-runner.ts:88-115](../target-idb/src/core/migration-runner.ts#L88-L115).
Extract it into a shared module (e.g. `target-idb/src/core/apply-ddl-op.ts`)
during this phase so both consumers import the same implementation.
Mark the original as the canonical home.

### `packages/prisma-orm/family-idb/package.json` (update)

Add `fake-indexeddb` as a dependency (it ships with the CLI tool):

```json
{
  "dependencies": {
    // ... existing ...
    "fake-indexeddb": "^6.2.5"
  }
}
```

This is the **only** legitimate dependency of `fake-indexeddb` in the
production codebase after this phase. Runtime code (target-idb's
runner, client-idb's auto-migrate) does not need it.

## Tests

### `packages/prisma-orm/family-idb/test/preflight.test.ts` (new)

- **Happy chain**: fixture with 2 migrations (`null → A`, `A → B`). →
  Exit 0, both report "ok".
- **Broken DDL**: fixture where migration 2 tries to drop a non-existent
  index. → Exit 1, error message names the failing package and step.
- **Broken chain metadata**: fixture where migration 2's `from` doesn't
  match migration 1's `to`. → Exit 1, "Chain broken at …" error.
- **No migrations**: empty `migrations/app/`. → Exit 0, prints "Nothing
  to preflight".

### CI integration (recommended, separate task)

Add to `apps/prisma-orm-usage/package.json` (or root):

```json
{
  "scripts": {
    "test:preflight": "prisma-next-idb preflight"
  }
}
```

Then in CI:

```yaml
- run: pnpm test:preflight
- run: pnpm test:e2e
```

Not required for the phase to land, but the value is wasted if no one
runs it.

## Acceptance criteria

- [ ] `pnpm -F @prisma-next-idb/family-idb build` succeeds.
- [ ] `npx prisma-next-idb preflight` runs in `apps/prisma-orm-usage`
      after 7.7 creates a migration package; reports "ok" for each.
- [ ] `pnpm -F @prisma-next-idb/family-idb test` passes (new preflight tests).
- [ ] `applyOneDdlOp` is in a single shared module, imported by both
      target-idb/runner and family-idb/preflight.

## Optional extension (deferred)

- **Schema diff vs `end-contract.json`**: after walking the chain, also
  introspect the reconstructed DB and diff it against the head package's
  `end-contract.json`. Reports any drift. Useful for catching cases
  where a hand-edited `migration.ts` produces ops that apply cleanly
  but don't actually produce the declared schema.
- **`--from`/`--to` flags**: validate just a sub-chain. Not needed for
  v1.

## Vendor cross-reference

- [`migration-check`](../../../vendor/prisma-next/packages/1-framework/3-tooling/cli/src/commands/migration-check/) — vendor's equivalent for SQL; uses Postgres in shadow mode rather than fake-indexeddb but the same conceptual purpose.
