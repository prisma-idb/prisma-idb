# Phase 7.5 — ContractSpace codegen (`prisma-next-idb generate-contract-space`)

**Status**: Not started
**Depends on**: 7.1 (manifest gone, family-idb is the package the new CLI lives in)
**Blocks**: 7.7 (app needs the generated module)

## Goal

Provide a CLI command that reads the user's migrations directory plus
`contract.json` and emits a TypeScript module that wires everything into
a `ContractSpace`, ready for `createAutoMigratingIdbClient` to consume.

Without this command, every user would have to hand-edit a long list of
JSON imports each time they add a migration. The vendor's extension
descriptors (e.g. postgis) hand-write these because they're per-extension
fixtures; for end-user apps, the list churns with every migration.

## Output shape (target)

```ts
// src/lib/prisma/contract-space.generated.ts
// THIS FILE IS AUTO-GENERATED — do not edit by hand.
// Regenerate with: prisma-next-idb generate-contract-space

import type { Contract } from "./contract";
import { contractSpaceFromJson } from "@prisma-next/migration-tools/spaces";
import contractJson from "./contract.json" with { type: "json" };
import headRef from "../../migrations/refs/head.json" with { type: "json" };
import mig_20260526T123456_baseline_meta from "../../migrations/app/20260526T123456_baseline/migration.json" with { type: "json" };
import mig_20260526T123456_baseline_ops from "../../migrations/app/20260526T123456_baseline/ops.json" with { type: "json" };
import mig_20260601T093020_addAuthor_meta from "../../migrations/app/20260601T093020_addAuthor/migration.json" with { type: "json" };
import mig_20260601T093020_addAuthor_ops from "../../migrations/app/20260601T093020_addAuthor/ops.json" with { type: "json" };

export const contractSpace = contractSpaceFromJson<Contract>({
  contractJson,
  migrations: [
    {
      dirName: "20260526T123456_baseline",
      metadata: mig_20260526T123456_baseline_meta,
      ops: mig_20260526T123456_baseline_ops,
    },
    {
      dirName: "20260601T093020_addAuthor",
      metadata: mig_20260601T093020_addAuthor_meta,
      ops: mig_20260601T093020_addAuthor_ops,
    },
  ],
  headRef,
});
```

Import identifiers are derived from `dirName` via a deterministic
sanitisation (replace `-` with `_`, prefix with `mig_`, suffix with
`_meta`/`_ops`).

## Where this command lives

**Decision**: ship as a binary in `family-idb`. Rationale:

- `family-idb` already depends on Node-only modules (it had the
  manifest driver, now deleted) and is the only package consumers
  install for CLI-time tooling.
- `target-idb` stays a pure target descriptor + migration runner; no
  CLI binary.
- A separate package (`@prisma-next-idb/cli`) is overkill until we
  have ≥3 commands.

After 7.6 lands, `family-idb` will own two commands (`generate-contract-space`
and `preflight`). When that grows, we can split into `@prisma-next-idb/cli`.

## Files to create

### `packages/prisma-orm/family-idb/src/bin/prisma-idb.ts` (new)

CLI entrypoint. Uses `commander` (already in the workspace via
`prisma-next`) or `node:util.parseArgs` for minimal deps.

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { generateContractSpace } from "../core/contract-space-codegen";

const { positionals } = parseArgs({ allowPositionals: true });
const [subcommand] = positionals;

async function main(): Promise<number> {
  switch (subcommand) {
    case "generate-contract-space":
      return generateContractSpace({ cwd: process.cwd() });
    case undefined:
    case "help":
    case "--help":
      printHelp();
      return 0;
    default:
      console.error(`Unknown command: ${subcommand}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(
    "prisma-next-idb — IDB-specific tooling for Prisma Next\n" +
      "\n" +
      "Usage:\n" +
      "  prisma-next-idb generate-contract-space   Write contract-space.generated.ts\n" +
      "  prisma-next-idb preflight                 Validate migration chain against fake-indexeddb (added in 7.6)\n" +
      "  prisma-next-idb help                      Show this message\n"
  );
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
);
```

### `packages/prisma-orm/family-idb/src/core/contract-space-codegen.ts` (new)

```ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "pathe";

// Reuse the framework's MigrationMetadata loader-schema to validate
// each migration.json before including it. Avoids generating a broken
// module for partially-written packages.
import type { MigrationMetadata } from "@prisma-next/migration-tools/metadata";

export interface GenerateContractSpaceOptions {
  readonly cwd: string;
  readonly configPath?: string; // defaults to <cwd>/prisma-next.config.ts
  readonly outPath?: string; // overrides the inferred path
}

export async function generateContractSpace(opts: GenerateContractSpaceOptions): Promise<number> {
  // 1. Load prisma-next.config.ts to find:
  //    - migrations.dir (relative to cwd)
  //    - contract source path (where contract.json lives)
  //    For now, hard-code conventional paths:
  //      migrations dir = <cwd>/migrations
  //      contract source = <cwd>/src/lib/prisma/contract.json
  //    The user's config has both; expose them via a tiny config loader.

  const migrationsDir = join(opts.cwd, "migrations");
  const appDir = join(migrationsDir, "app");
  const refsDir = join(migrationsDir, "refs");
  const contractJsonPath = join(opts.cwd, "src/lib/prisma/contract.json");
  const outPath = opts.outPath ?? join(opts.cwd, "src/lib/prisma/contract-space.generated.ts");

  // 2. List migration packages.
  let entries: string[];
  try {
    entries = (await readdir(appDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // lexicographic = timestamp order
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No migrations yet — emit a minimal module with empty migrations.
      entries = [];
    } else {
      throw err;
    }
  }

  // 3. Validate each package has migration.json + ops.json.
  const packages: Array<{ dirName: string; metadata: MigrationMetadata }> = [];
  for (const dirName of entries) {
    const metaPath = join(appDir, dirName, "migration.json");
    const opsPath = join(appDir, dirName, "ops.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const metadata = JSON.parse(raw) as MigrationMetadata;
      await readFile(opsPath, "utf-8"); // existence check
      packages.push({ dirName, metadata });
    } catch (err) {
      console.error(`Skipping ${dirName}: missing or unreadable migration.json/ops.json (${(err as Error).message})`);
    }
  }

  // 4. Verify chain connectivity.
  validateChain(packages);

  // 5. Compute the headRef (latest migration's `to`).
  //    Vendor's convention is to also keep migrations/refs/head.json on
  //    disk — re-derive from the chain and write it.
  const headRef = packages.length === 0 ? null : { hash: packages[packages.length - 1].metadata.to, invariants: [] };

  if (headRef !== null) {
    await writeFile(join(refsDir, "head.json"), JSON.stringify(headRef, null, 2) + "\n", "utf-8");
  }

  // 6. Render the module.
  const source = renderModule({
    contractJsonImportPath: relative(dirname(outPath), contractJsonPath),
    headRefImportPath: relative(dirname(outPath), join(refsDir, "head.json")),
    packages: packages.map((p) => ({
      dirName: p.dirName,
      metaImportPath: relative(dirname(outPath), join(appDir, p.dirName, "migration.json")),
      opsImportPath: relative(dirname(outPath), join(appDir, p.dirName, "ops.json")),
    })),
  });

  await writeFile(outPath, source, "utf-8");
  console.log(`Wrote ${outPath} (${packages.length} migration${packages.length === 1 ? "" : "s"})`);
  return 0;
}

function validateChain(packages: ReadonlyArray<{ dirName: string; metadata: MigrationMetadata }>): void {
  let cursor: string | null = null;
  for (const pkg of packages) {
    if (pkg.metadata.from !== cursor) {
      throw new Error(
        `Chain broken at ${pkg.dirName}: expected from === ${JSON.stringify(cursor)}, got ${JSON.stringify(pkg.metadata.from)}`
      );
    }
    cursor = pkg.metadata.to;
  }
}

function renderModule(input: {
  readonly contractJsonImportPath: string;
  readonly headRefImportPath: string;
  readonly packages: ReadonlyArray<{
    readonly dirName: string;
    readonly metaImportPath: string;
    readonly opsImportPath: string;
  }>;
}): string {
  const identFromDir = (dirName: string): string => "mig_" + dirName.replace(/[^a-zA-Z0-9_]/g, "_");

  const importLines: string[] = [
    `import type { Contract } from "./contract";`,
    `import { contractSpaceFromJson } from "@prisma-next/migration-tools/spaces";`,
    `import contractJson from "${input.contractJsonImportPath}" with { type: "json" };`,
    `import headRef from "${input.headRefImportPath}" with { type: "json" };`,
  ];

  for (const pkg of input.packages) {
    const id = identFromDir(pkg.dirName);
    importLines.push(`import ${id}_meta from "${pkg.metaImportPath}" with { type: "json" };`);
    importLines.push(`import ${id}_ops from "${pkg.opsImportPath}" with { type: "json" };`);
  }

  const migrationsArrayBody = input.packages
    .map((pkg) => {
      const id = identFromDir(pkg.dirName);
      return `  { dirName: ${JSON.stringify(pkg.dirName)}, metadata: ${id}_meta, ops: ${id}_ops },`;
    })
    .join("\n");

  return [
    "// THIS FILE IS AUTO-GENERATED — do not edit by hand.",
    "// Regenerate with: prisma-next-idb generate-contract-space",
    "",
    ...importLines,
    "",
    "export const contractSpace = contractSpaceFromJson<Contract>({",
    "  contractJson,",
    "  migrations: [",
    migrationsArrayBody,
    "  ],",
    "  headRef,",
    "});",
    "",
  ].join("\n");
}
```

### `packages/prisma-orm/family-idb/package.json` (update)

Add `bin` entry, deps:

```json
{
  "bin": {
    "prisma-next-idb": "./dist/bin/prisma-next-idb.mjs"
  },
  "dependencies": {
    "@prisma-next/config": "^0.11.0",
    "@prisma-next/contract": "^0.11.0",
    "@prisma-next/framework-components": "^0.11.0",
    "@prisma-next/migration-tools": "^0.11.0",
    "@prisma-next/utils": "^0.11.0",
    "@prisma-next-idb/target-idb": "workspace:*",
    "pathe": "^2.0.3"
  }
}
```

### `packages/prisma-orm/family-idb/tsdown.config.ts` (update)

Add the bin entrypoint:

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/exports/control.ts",
    "src/exports/pack.ts",
    "src/exports/contract-ts.ts",
    "src/exports/config-types.ts",
    "src/bin/prisma-idb.ts",
  ],
  outDir: "dist",
  format: "esm",
  dts: true,
  shims: true, // for #!/usr/bin/env node
});
```

## Tests

### `packages/prisma-orm/family-idb/test/contract-space-codegen.test.ts` (new)

- Build a tmpdir with a contract.json and 2 migration packages (fixtures).
- Run `generateContractSpace({ cwd: tmpDir })`.
- Snapshot the generated module.
- Assert `migrations/refs/head.json` was written and points at the last migration's `to`.
- Assert `validateChain` throws on a broken chain fixture.

### Manual smoke test

```bash
cd apps/prisma-orm-usage
npx prisma-next-idb generate-contract-space
cat src/lib/prisma/contract-space.generated.ts
```

(Phase 7.7 does this in earnest.)

## Acceptance criteria

- [ ] `pnpm -F @prisma-next-idb/family-idb build` produces a `bin/prisma-next-idb.mjs`.
- [ ] `npx prisma-next-idb help` shows the help text.
- [ ] `npx prisma-next-idb generate-contract-space` works in a project
      with at least one migration package.
- [ ] Generated module typechecks under the user's tsconfig.
- [ ] Codegen is idempotent (re-running produces byte-identical output).

## Open question (not blocking)

**Where to source the contract.json path from?** The current
implementation hard-codes `src/lib/prisma/contract.json`. The user's
`prisma-next.config.ts` has `contract: typescriptContract(contract, "src/lib/prisma/contract.json")` — we should read that path from
config rather than hard-coding. Adds a small config-loading step but
makes the command portable across projects.

Decide during implementation: if the config loader is too heavy
(it requires dynamic-import of a TS file), keep the hard-coded path
in 7.5 and add a `--contract <path>` flag for override; revisit in a
follow-up phase.

## Vendor cross-reference

- [`postgis/src/exports/control.ts`](../../../vendor/prisma-next/packages/3-extensions/postgis/src/exports/control.ts) — the hand-written analogue we're auto-generating
- [`@prisma-next/migration-tools/spaces`](../../../node_modules/.pnpm/@prisma-next+migration-tools@0.11.0/node_modules/@prisma-next/migration-tools/dist/exports/spaces.mjs) — `contractSpaceFromJson` we wire into the generated module
- [migration package layout](../../../vendor/prisma-next/packages/3-extensions/postgis/migrations/) — `refs/head.json` shape we re-derive
