import type { Contract } from "@prisma/orm-framework/contract/types";
import type { TargetBoundComponentDescriptor } from "@prisma/orm-framework/components/components";
import type {
  MigrationOperationPolicy,
  MigrationPlanWithAuthoringSurface,
  MigrationPlanner,
  MigrationPlannerResult,
  MigrationScaffoldContext,
} from "@prisma/orm-framework/components/control";
import type { IdbIndexDefinition, IdbStoreDefinition } from "./idb-contract-types";
import { createMarkerStoreOp, type IdbDdlOp } from "./migration-factories";
import type { IdbSchemaDiffInput } from "./schema-diff";
import { diffIdbSchema } from "./schema-diff";

// ── Plan type ─────────────────────────────────────────────────────────────────

/**
 * IDB-specific migration plan.
 *
 * Extends `MigrationPlanWithAuthoringSurface` by narrowing `operations` to
 * `readonly IdbDdlOp[]`. This is a valid covariant narrowing because
 * `IdbDdlOp extends MigrationPlanOperation`.
 */
export interface IdbMigrationPlanWithAuthoring extends MigrationPlanWithAuthoringSurface {
  readonly operations: readonly IdbDdlOp[];
}

// ── Contract → schema IR extraction ──────────────────────────────────────────

/**
 * The `storage` section of a raw contract, or `null` when the contract has
 * none. Contracts arrive as `unknown` / `Contract` at planner call sites, so
 * the lookup is dynamic.
 */
function contractStorage(contract: unknown): Record<string, unknown> | null {
  if (contract === null || typeof contract !== "object") return null;
  const storage = (contract as Record<string, unknown>)["storage"];
  return storage !== null && typeof storage === "object" ? (storage as Record<string, unknown>) : null;
}

/**
 * Extract an `IdbSchemaDiffInput` from a raw contract object.
 *
 * Returns `null` for a null contract (fresh database — no prior schema).
 */
export function contractToIdbSchema(contract: unknown): IdbSchemaDiffInput | null {
  const stores = contractStorage(contract)?.["stores"];
  if (stores === null || typeof stores !== "object") return null;
  return { stores: stores as Record<string, IdbStoreDefinition> };
}

function extractStorageHash(contract: unknown): string {
  const hash = contractStorage(contract)?.["storageHash"];
  return typeof hash === "string" ? hash : "unknown";
}

// ── TypeScript scaffold renderer ──────────────────────────────────────────────

/**
 * Render a class-based `migration.ts` scaffold from a planner-derived ops
 * list plus the `describe()` identity bookends. The output is the
 * canonical authoring surface — identical in shape to vendor's Postgres
 * `renderCallsToTypeScript` (shebang → imports → class → describe →
 * operations → MigrationCLI.run).
 *
 * Exported so callers that need to render a scaffold from a modified ops
 * list (e.g. an extension-space baseline that strips the marker-store op —
 * see `migration-plan.ts`) can bypass `plan.renderTypeScript()`, which
 * always renders the planner's original `plan.operations`.
 */
export function renderMigrationTs(input: {
  readonly fromHash: string | null;
  readonly toHash: string;
  readonly ops: readonly IdbDdlOp[];
}): string {
  const { fromHash, toHash, ops } = input;

  const factoryImports = collectFactoryImports(ops);
  const importList = ["Migration", "MigrationCLI", ...factoryImports].join(", ");

  const operationsBlock =
    ops.length === 0
      ? [
          "    return [",
          "      // Add IDB DDL operations here (createObjectStoreOp, createIndexOp, ...).",
          "    ];",
        ].join("\n")
      : ["    return [", ops.map((op) => `      ${renderOpCall(op)},`).join("\n"), "    ];"].join("\n");

  return [
    "#!/usr/bin/env -S npx tsx",
    `import { ${importList} } from "@prisma-idb/target-idb/migration";`,
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

/**
 * Render an `IdbIndexDefinition` as an object-literal source fragment.
 *
 * `unique`/`multiEntry` are rendered only when actually present on `def` —
 * never defaulted. The contract canonicaliser strips `unique: false` /
 * `multiEntry: false` from indexes (default-stripping), so an absent key
 * here means "not set", not "false". Rendering an explicit `false` would
 * break the self-emit round trip: `JSON.stringify` drops an `undefined`
 * value's key but keeps `false`, so re-emitting `ops.json` from the rendered
 * TS would produce different bytes — and a different `migrationHash` — than
 * the planner's original output. That would violate `MigrationCLI.run`'s
 * "re-running this file reproduces its own artifacts" contract. Shared by
 * the standalone `createIndexOp(...)` call and the `indexes` map embedded in
 * a `createObjectStoreOp(...)` def so both sites stay symmetric.
 */
function renderIndexDefLiteral(def: IdbIndexDefinition): string {
  const optsParts = [`keyPath: ${JSON.stringify(def.keyPath)}`];
  if (def.unique !== undefined) {
    optsParts.push(`unique: ${def.unique}`);
  }
  if (def.multiEntry !== undefined) {
    optsParts.push(`multiEntry: ${def.multiEntry}`);
  }
  return `{ ${optsParts.join(", ")} }`;
}

function renderOpCall(op: IdbDdlOp): string {
  switch (op.kind) {
    case "transformRecords":
      throw new Error("IDB: transformRecords must be authored by hand in migration.ts");
    case "createObjectStore": {
      const optsParts = [`keyPath: ${JSON.stringify(op.def.keyPath)}`];
      if (op.def.autoIncrement !== undefined) {
        optsParts.push(`autoIncrement: ${op.def.autoIncrement}`);
      }
      // `diffIdbSchema` passes the full contract store definition (indexes
      // included) into `createObjectStoreOp`'s `def` for a freshly-created
      // store. `applyOneDdlOp` never reads `def.indexes` (the separate
      // `createIndexOp`s do the work), so this is inert metadata. It is
      // still rendered: the planner's `ops.json` has it, and a re-emit that
      // dropped it would produce different hashes (see `renderIndexDefLiteral`).
      if (op.def.indexes !== undefined && Object.keys(op.def.indexes).length > 0) {
        const entries = Object.entries(op.def.indexes)
          .map(([indexName, def]) => `${JSON.stringify(indexName)}: ${renderIndexDefLiteral(def)}`)
          .join(", ");
        optsParts.push(`indexes: { ${entries} }`);
      }
      return `createObjectStoreOp(${JSON.stringify(op.storeName)}, { ${optsParts.join(", ")} })`;
    }
    case "dropObjectStore":
      return `dropObjectStoreOp(${JSON.stringify(op.storeName)})`;
    case "createIndex":
      return `createIndexOp(${JSON.stringify(op.storeName)}, ${JSON.stringify(op.indexName)}, ${renderIndexDefLiteral(op.def)})`;
    case "dropIndex":
      return `dropIndexOp(${JSON.stringify(op.storeName)}, ${JSON.stringify(op.indexName)})`;
  }
}

// ── Planner ───────────────────────────────────────────────────────────────────

/**
 * IDB migration planner.
 *
 * `plan()` converts `fromContract` and `contract` into `IdbSchemaDiffInput`s,
 * diffs them using {@link diffIdbSchema}, and returns an
 * {@link IdbMigrationPlanWithAuthoring} that can be executed by
 * {@link IdbMigrationRunner} or rendered to a TypeScript migration file via
 * the class-based scaffold matching vendor's Postgres/Mongo authoring surface.
 *
 * The planner does NOT apply the policy — it always returns the full op set.
 * Policy enforcement happens in the runner and in the browser-side
 * auto-migrate path.
 */
export class IdbMigrationPlanner implements MigrationPlanner<"idb", "idb"> {
  plan(options: {
    readonly contract: unknown;
    readonly schema: unknown;
    readonly policy: MigrationOperationPolicy;
    readonly fromContract: Contract | null;
    readonly frameworkComponents: ReadonlyArray<TargetBoundComponentDescriptor<"idb", "idb">>;
    /**
     * Contract space this plan applies to.
     *
     * Stamped onto the produced plan so the runner keys the marker row
     * by the right space. IDB only has a single space (`"app"`), but
     * the parameter is required by the framework's
     * {@link MigrationPlanner} interface (added for multi-space support
     * in contract-spaces ADR 212). Ignored by the IDB planner — all
     * IDB schemas are single-space.
     */
    readonly spaceId: string;
  }): MigrationPlannerResult {
    const { contract, fromContract } = options;

    const fromSchema = contractToIdbSchema(fromContract);
    const toSchema = contractToIdbSchema(contract);

    if (toSchema === null) {
      return {
        kind: "failure",
        conflicts: [
          {
            kind: "invalidContract",
            summary:
              "Could not extract IDB schema from contract. " +
              "Expected contract.storage.stores to be a record of IdbStoreDefinition.",
          },
        ],
      };
    }

    const ops = diffIdbSchema(fromSchema, toSchema);

    // On first migration (fresh database), create the internal
    // _prisma_next_marker store so the runtime can verify the
    // contract marker before executing queries. Subsequent migrations
    // don't need this — the marker store persists across upgrades
    // since it's an internal store not declared in the user's contract.
    if (fromSchema === null) {
      ops.unshift(createMarkerStoreOp());
    }

    const fromHash = fromContract !== null ? extractStorageHash(fromContract) : null;
    const toHash = extractStorageHash(contract);

    const plan: IdbMigrationPlanWithAuthoring = {
      targetId: "idb",
      // `null` means "no origin validation" — the runner skips the origin check.
      origin: fromHash !== null ? { storageHash: fromHash } : null,
      destination: { storageHash: toHash },
      operations: ops,
      renderTypeScript() {
        return renderMigrationTs({ fromHash, toHash, ops });
      },
    };

    return { kind: "success", plan };
  }

  emptyMigration(context: MigrationScaffoldContext, _spaceId: string): MigrationPlanWithAuthoringSurface {
    const { fromHash, toHash } = context;
    return {
      targetId: "idb",
      origin: fromHash !== null ? { storageHash: fromHash } : null,
      destination: { storageHash: toHash },
      operations: [],
      renderTypeScript() {
        return renderMigrationTs({ fromHash, toHash, ops: [] });
      },
    };
  }
}
