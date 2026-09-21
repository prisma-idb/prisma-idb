# Phase 7.2 — Planner refit: class-based `migration.ts` scaffold

**Status**: Not started
**Depends on**: 7.1 (needs `IdbMigration` + `MigrationCLI` exports)
**Blocks**: 7.4 (browser stops importing planner; design-time only) — not strictly, but functionally tied

## Goal

Make `IdbMigrationPlanner.renderTypeScript()` emit a scaffold matching
vendor's class-based shape with `MigrationCLI.run(...)` at the bottom.
This is the **single contact point** with the framework's
`prisma-next migration plan` / `migration new` CLI — the framework
calls our planner's `renderTypeScript()` and writes the result to disk.

Once this change lands:

- `prisma-next migration plan` generates a class-based `migration.ts`
- `node migration.ts` self-emits `ops.json` + `migration.json`
- The migration package is fully usable by the runtime (7.4) and CLI
  tooling (7.5/7.6)

## Files to update

### `packages/prisma-orm/target-idb/src/core/migration-planner.ts`

Replace `renderDdlOpsTs(ops)` (current at lines 73-129) and
`EMPTY_MIGRATION_STUB` (lines 59-71) with a class-based renderer
parametrised by the planner's `origin`/`destination`/`operations`.

New shape:

```ts
import { dedent } from "@prisma-next/utils/dedent"; // or local helper

function renderMigrationTs(input: {
  readonly fromHash: string | null;
  readonly toHash: string;
  readonly ops: readonly IdbDdlOp[];
}): string {
  const { fromHash, toHash, ops } = input;
  const factoryImports = collectFactoryImports(ops);
  const opsBody = ops.map(renderOpCall).join(",\n");
  const operationsBlock =
    ops.length === 0
      ? "    return [\n      // Add IDB DDL operations here (createObjectStoreOp, createIndexOp, ...)\n    ];"
      : `    return [\n${indent(opsBody, 6)},\n    ];`;

  return [
    "#!/usr/bin/env -S npx tsx",
    "",
    `import { Migration, MigrationCLI${factoryImports.length > 0 ? `, ${factoryImports.join(", ")}` : ""} } from "@prisma-next-idb/target-idb/migration";`,
    "",
    "export default class M extends Migration {",
    "  override describe() {",
    "    return {",
    `      from: ${JSON.stringify(fromHash)},`,
    `      to: ${JSON.stringify(toHash)},`,
    "    };",
    "  }",
    "",
    "  override get operations() {",
    operationsBlock,
    "  }",
    "}",
    "",
    "MigrationCLI.run(import.meta.url, M);",
    "",
  ].join("\n");
}

function collectFactoryImports(ops: readonly IdbDdlOp[]): string[] {
  const names = new Set<string>();
  for (const op of ops) {
    switch (op.kind) {
      case "createObjectStore":
        names.add("createObjectStoreOp");
        break;
      case "dropObjectStore":
        names.add("dropObjectStoreOp");
        break;
      case "createIndex":
        names.add("createIndexOp");
        break;
      case "dropIndex":
        names.add("dropIndexOp");
        break;
    }
  }
  return [...names].sort();
}

function renderOpCall(op: IdbDdlOp): string {
  switch (op.kind) {
    case "createObjectStore": {
      const optsParts = [`keyPath: "${op.def.keyPath}"`];
      if (op.def.autoIncrement !== undefined) {
        optsParts.push(`autoIncrement: ${op.def.autoIncrement}`);
      }
      return `      createObjectStoreOp("${op.storeName}", { ${optsParts.join(", ")} })`;
    }
    case "dropObjectStore":
      return `      dropObjectStoreOp("${op.storeName}")`;
    case "createIndex": {
      const unique = op.def.unique ?? false;
      const optsParts = [`keyPath: "${op.def.keyPath}"`, `unique: ${unique}`];
      if (op.def.multiEntry !== undefined) {
        optsParts.push(`multiEntry: ${op.def.multiEntry}`);
      }
      return `      createIndexOp("${op.storeName}", "${op.indexName}", { ${optsParts.join(", ")} })`;
    }
    case "dropIndex":
      return `      dropIndexOp("${op.storeName}", "${op.indexName}")`;
  }
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}
```

Wire it into `plan()` and `emptyMigration()`:

```ts
const plan: IdbMigrationPlanWithAuthoring = {
  targetId: "idb",
  origin: fromContract !== null ? { storageHash: fromHash } : null,
  destination: { storageHash: toHash },
  operations: ops,
  renderTypeScript() {
    return renderMigrationTs({ fromHash: fromContract !== null ? fromHash : null, toHash, ops });
  },
};

// emptyMigration:
emptyMigration(context: MigrationScaffoldContext, _spaceId: string): MigrationPlanWithAuthoringSurface {
  return {
    targetId: "idb",
    origin: context.fromHash !== null ? { storageHash: context.fromHash } : null,
    destination: { storageHash: context.toHash },
    operations: [],
    renderTypeScript() {
      return renderMigrationTs({
        fromHash: context.fromHash,
        toHash: context.toHash,
        ops: [],
      });
    },
  };
}
```

`MigrationScaffoldContext` carries `fromHash` and `toHash` already
([framework-components/control](../../../node_modules/.pnpm/@prisma-next+framework-components@0.11.0/node_modules/@prisma-next/framework-components/dist/exports/control.d.mts)).
Verify by reading the type before implementing.

### `packages/prisma-orm/target-idb/test/migration.test.ts`

Update planner tests:

- `renderTypeScript()` output now starts with `#!/usr/bin/env -S npx tsx` and
  contains `class M extends Migration` + `MigrationCLI.run(import.meta.url, M)`.
- Use snapshot tests for the rendered output so future format tweaks
  show up clearly in diffs.
- Add a round-trip test: render TS → write to tmp file → eval (via
  `import()` with `--experimental-strip-types` or use a fixture that's
  pre-compiled to JS) → call `M`'s `operations` getter → assert it
  matches the original ops list.

## Files to delete

None.

## Files to create

None — all changes in `migration-planner.ts` and its tests.

## Acceptance criteria

- [ ] `pnpm -F @prisma-next-idb/target-idb build` succeeds.
- [ ] `pnpm -F @prisma-next-idb/target-idb test` passes (snapshot tests
      updated, round-trip test added).
- [ ] `renderTypeScript()` output for a sample migration is byte-identical
      to a hand-authored equivalent (verify with vendor's Postgres pattern
      as a structural reference).
- [ ] No `IdbMigration` import path in the renderer points at the wrong
      module — must be `@prisma-next-idb/target-idb/migration` so the
      generated file works when copied into a user's app.

## Non-goals (deferred)

- **Hand-edit detection** (warning when the user edited `migration.ts`
  but didn't re-emit `ops.json`). Vendor's `MigrationCLI` does this via
  hash comparison; ours doesn't yet. Add in a follow-up phase if needed.
- **`placeholder()` injection** for ops the planner can't auto-generate.
  Today our planner only emits the four DDL ops; backfills / renames
  require hand-editing anyway. When we add `dataTransform` support, this
  is where the scaffold injects `placeholder("write the data-transform
closure here", () => { ... })`.

## Vendor cross-reference

- [`render-typescript.ts` (Postgres)](../../../vendor/prisma-next/packages/3-targets/3-targets/postgres/src/core/migrations/render-typescript.ts) — our shape mirrors theirs:
  `shebang → imports → class M extends Migration → describe → operations → MigrationCLI.run`
- [`postgres/exports/migration.ts`](../../../vendor/prisma-next/packages/3-targets/3-targets/postgres/src/exports/migration.ts) — the import surface we mirror in target-idb (single import covers Migration + MigrationCLI + factories)
