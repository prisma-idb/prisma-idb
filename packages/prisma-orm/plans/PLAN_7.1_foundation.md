# Phase 7.1 — Foundation: `IdbMigration` base class, `MigrationCLI` shim

**Status**: In progress
**Depends on**: —
**Blocks**: 7.2, 7.3, 7.4, 7.5, 7.6

## Goal

Lay the type and wiring foundation for the rest of Phase 7 so subsequent
phases can swap planner/runner/browser implementations without re-shaping
the surface.

Two concrete deliverables:

1. **`IdbMigration` abstract class** in `target-idb` — the base every authored
   `migration.ts` file extends. Mirrors vendor's
   `PostgresMigration`/`MongoMigration` pattern.
2. **`MigrationCLI` shim** in `target-idb` — re-exported from
   `target-idb/migration` so user `migration.ts` files only need a single
   import for both base class and self-emit entrypoint. Local
   implementation (we can't reuse `@prisma-next/cli/migration-cli` —
   it's workspace-internal to vendor).

> **Scope adjustment 2026-05-26**: the original plan also called for
> deleting the manifest layer in `family-idb`. Mid-implementation audit
> found that `family-idb/src/core/control-instance.ts` has six
> manifest-backed methods (`verify`, `sign`, `readMarker`,
> `readAllMarkers`, `introspect`, and `verifySchema`) that all need to
> become structured refusals when the manifest goes. Refit + deletion
> together belongs in **Phase 7.3** alongside the runner refit (both
> are the "CLI control plane has no IDB to talk to" change viewed from
> different angles). 7.1 keeps the manifest alive and ships purely
> additive types.

## Files to create

### `packages/prisma-orm/target-idb/src/core/idb-migration.ts` (new)

```ts
import type { ControlStack } from "@prisma-next/framework-components/control";
import { Migration } from "@prisma-next/migration-tools/migration";
import type { IdbDdlOp } from "./migration-factories";

/**
 * Base class for IDB migrations.
 *
 * Each user-authored `migration.ts` file extends this class and provides:
 *   - `describe()` — returns `{ from, to, labels? }` for the metadata file.
 *   - `get operations()` — returns the ordered list of `IdbDdlOp`s.
 *
 * The `ControlStack` parameter is accepted but unused by IDB migrations —
 * unlike SQL, IDB ops are pure data with no SQL-string compilation or
 * adapter-driven materialisation. Kept so the constructor signature
 * matches what `MigrationCLI.run()` and the framework's apply path
 * expect.
 */
export abstract class IdbMigration extends Migration<IdbDdlOp, "idb", "idb"> {
  override readonly targetId = "idb" as const;

  constructor(stack?: ControlStack<"idb", "idb">) {
    super(stack);
  }

  abstract override get operations(): readonly IdbDdlOp[];
}
```

### `packages/prisma-orm/target-idb/src/core/migration-cli.ts` (new)

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildMigrationArtifacts, isDirectEntrypoint } from "@prisma-next/migration-tools/migration";
import type { MigrationMetadata } from "@prisma-next/migration-tools/metadata";
import { dirname, join } from "pathe";
import type { IdbMigration } from "./idb-migration";

type IdbMigrationConstructor = new () => IdbMigration;

/**
 * Self-emit CLI invoked by an authored `migration.ts` file:
 *
 *   `MigrationCLI.run(import.meta.url, M);`
 *
 * When run as a node entrypoint (`node migration.ts`), regenerates
 * `ops.json` and `migration.json` next to the file based on the
 * current `operations` and `describe()` output of the migration class.
 * When imported by other code, returns 0 without doing anything.
 *
 * No config loading or control-stack assembly — IDB migrations are pure
 * data, so we don't need the stack at self-emit time. This keeps the
 * shim free of `@prisma-next/cli` (workspace-internal in vendor).
 */
export class MigrationCLI {
  static async run(importMetaUrl: string, MigrationClass: IdbMigrationConstructor): Promise<number> {
    if (!isDirectEntrypoint(importMetaUrl)) return 0;

    const { values } = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: false,
    });

    if (values.help) {
      process.stdout.write(
        "Usage: node migration.ts [--dry-run]\n" + "\n" + "Re-emits ops.json and migration.json next to this file.\n"
      );
      return 0;
    }

    const instance = new MigrationClass();
    const migrationDir = dirname(fileURLToPath(importMetaUrl));
    const metaPath = join(migrationDir, "migration.json");

    let existing: Partial<MigrationMetadata> | null = null;
    try {
      const raw = readFileSync(metaPath, "utf-8");
      existing = JSON.parse(raw) as Partial<MigrationMetadata>;
    } catch {
      // No previous metadata — fresh emit.
    }

    const { opsJson, metadataJson } = buildMigrationArtifacts(instance, existing);

    if (values["dry-run"]) {
      process.stdout.write(`--- migration.json ---\n${metadataJson}\n`);
      process.stdout.write(`--- ops.json ---\n${opsJson}\n`);
      return 0;
    }

    writeFileSync(join(migrationDir, "ops.json"), opsJson);
    writeFileSync(metaPath, metadataJson);
    process.stdout.write(`Wrote ops.json + migration.json to ${migrationDir}\n`);
    return 0;
  }
}
```

## Files to update

### `packages/prisma-orm/target-idb/src/exports/migration.ts`

Add the new exports alongside the existing op factories so authored
migration files only need a single import:

```ts
// New exports
export { IdbMigration as Migration } from "../core/idb-migration";
export { MigrationCLI } from "../core/migration-cli";

// Keep existing factory exports (createObjectStoreOp, etc.)
```

Authoring surface becomes byte-for-byte aligned with vendor Postgres:

```ts
import { Migration, MigrationCLI, createObjectStoreOp } from "@prisma-next-idb/target-idb/migration";
```

### `packages/prisma-orm/target-idb/package.json`

Add new dependencies:

```json
{
  "dependencies": {
    "@prisma-next/contract": "^0.11.0",
    "@prisma-next/framework-components": "^0.11.0",
    "@prisma-next/migration-tools": "^0.11.0",
    "fake-indexeddb": "^6.2.5",
    "pathe": "^2.0.3"
  }
}
```

(Aside: `fake-indexeddb` will move to `devDependencies` after 7.3 deletes the dry-run path — track that there, not here.)

### `packages/prisma-orm/target-idb/tsdown.config.ts`

No build-entry change needed — `idb-migration.ts` and `migration-cli.ts`
are pulled in via `migration.ts`, which already builds.

## Files to delete

None in this phase. Manifest deletion lives in 7.3 (see scope adjustment
note at top).

## Tests

### Add `packages/prisma-orm/target-idb/test/idb-migration.test.ts`

Test the new base class:

- Instantiation with `operations` getter returns the expected ops
- `targetId === 'idb'`
- `describe()` consumed by `buildMigrationArtifacts` produces valid
  `migration.json` content

### Add `packages/prisma-orm/target-idb/test/migration-cli.test.ts`

Test the shim **without** invoking `node migration.ts` directly:

- Construct a fake `IdbMigration` subclass, call
  `MigrationCLI.run(import.meta.url, M)` while `isDirectEntrypoint`
  returns true (mock or use a fixture script)
- Assert `ops.json` and `migration.json` are written to disk
- Test `--dry-run` writes nothing
- Test no-op when imported (entrypoint check returns false)

Use `tmpdir()` for the migration directory in tests.

### No tests deleted in this phase

Manifest tests stay alive until 7.3 deletes the manifest itself.

## Acceptance criteria

- [ ] `pnpm -F @prisma-next-idb/target-idb build` succeeds.
- [ ] `pnpm -F @prisma-next-idb/family-idb build` succeeds (unchanged).
- [ ] `pnpm -F @prisma-next-idb/target-idb test` passes (new tests + existing).
- [ ] `pnpm -F @prisma-next-idb/family-idb test` passes (unchanged).
- [ ] `IdbMigration` and `MigrationCLI` are exported from `@prisma-next-idb/target-idb/migration` and consumable by a downstream `migration.ts`.

## Interlock with 7.3

The manifest layer in `family-idb` and the duck-typed manifest reads
in `target-idb/src/core/migration-runner.ts` stay in place until 7.3
deletes them together. 7.3's scope therefore expands beyond the original
"runner refit" to include:

- Refit of `family-idb/src/core/control-instance.ts` methods (`verify`,
  `sign`, `readMarker`, `readAllMarkers`, `introspect`) to structured
  refusals.
- Deletion of `manifest.ts` / `manifest-driver.ts` / their tests.
- Removal of manifest exports from `family-idb/src/exports/control.ts`.

See [PLAN_7.3_runner_refit.md](PLAN_7.3_runner_refit.md).

## Vendor cross-reference

- [`PostgresMigration` class](../../../vendor/prisma-next/packages/3-targets/3-targets/postgres/src/core/migrations/postgres-migration.ts)
- [`MigrationCLI.run`](../../../vendor/prisma-next/packages/1-framework/3-tooling/cli/src/migration-cli.ts) — our shim covers a strict subset (no config load, no clipanion, no structured-error envelopes)
- [Postgres `migration.ts` re-exports](../../../vendor/prisma-next/packages/3-targets/3-targets/postgres/src/exports/migration.ts) — we mirror the surface pattern (`Migration`, `MigrationCLI`, `placeholder`, factory functions)
