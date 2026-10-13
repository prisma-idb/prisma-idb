import type { Contract } from "@prisma/orm-framework/contract/types";
import type { TargetBoundComponentDescriptor } from "@prisma/orm-framework/components/components";
import type {
  MigrationOperationPolicy,
  MigrationPlanWithAuthoringSurface,
  MigrationPlanner,
  MigrationPlannerConflict,
  MigrationPlannerResult,
  MigrationScaffoldContext,
} from "@prisma/orm-framework/components/control";
import type { IdbIndexDefinition, IdbRecordField, IdbRecordFieldType, IdbStoreDefinition } from "./idb-contract-types";
import { keyPathFields } from "./idb-contract-types";
import {
  defaultIfMissing,
  placeholder,
  transformRecordsOp,
  createMarkerStoreOp,
  IDB_MARKER_STORE,
  type IdbDdlOp,
  type IdbValueTransform,
} from "./migration-factories";
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
      ? ["    return [", "      // No record or schema operations are needed for this migration.", "    ];"].join("\n")
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
      case "transformRecords":
        names.add("transformRecordsOp");
        for (const transform of Object.values(op.fields ?? {})) names.add(transform.kind);
        break;
      case "createObjectStore":
        names.add(
          op.storeName === IDB_MARKER_STORE && op.label === createMarkerStoreOp().label
            ? "createMarkerStoreOp"
            : "createObjectStoreOp"
        );
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
    case "transformRecords": {
      const parts: string[] = [];
      if (op.fields !== undefined) {
        const fields = Object.entries(op.fields).map(([name, transform]) => {
          if (transform.kind === "placeholder")
            return `[${JSON.stringify(name)}]: placeholder(${JSON.stringify(transform.slot)})`;
          if (transform.kind !== "defaultIfMissing") {
            throw new Error("IDB: custom transforms must be authored by hand in migration.ts");
          }
          return `[${JSON.stringify(name)}]: defaultIfMissing(${JSON.stringify(transform.value)})`;
        });
        parts.push(`fields: { ${fields.join(", ")} }`);
      }
      if (op.renameFields !== undefined) {
        throw new Error("IDB: renames must be authored by hand in migration.ts");
      }
      if (op.removeFields !== undefined) parts.push(`removeFields: ${JSON.stringify(op.removeFields)}`);
      return `transformRecordsOp(${JSON.stringify(op.storeName)}, { ${parts.join(", ")} })`;
    }
    case "createObjectStore": {
      // Preserve the internal marker's label as well as its DDL properties.
      if (op.storeName === IDB_MARKER_STORE && op.label === createMarkerStoreOp().label) {
        return "createMarkerStoreOp()";
      }
      const optsParts = [`keyPath: ${JSON.stringify(op.def.keyPath)}`];
      if (op.def.autoIncrement !== undefined) {
        optsParts.push(`autoIncrement: ${op.def.autoIncrement}`);
      }
      // `diffIdbSchema` keeps DDL properties (including indexes) in a
      // freshly-created store's `def`, omitting contract record metadata.
      // `applyOneDdlOp` never reads `def.indexes` (the separate
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

/** Whether a nested type change can preserve existing values without a transform. */
function typeAcceptsExistingValues(from: IdbRecordFieldType, to: IdbRecordFieldType): boolean {
  if (from.kind === "valueObject" && to.kind === "valueObject") {
    if (from.name !== to.name) return false;
    // Removed embedded fields need an authored transform; the record DSL only removes top-level fields.
    if (Object.keys(from.fields).some((name) => !Object.hasOwn(to.fields, name))) return false;
    return Object.entries(to.fields).every(([name, field]) =>
      Object.hasOwn(from.fields, name) ? fieldAcceptsExistingValues(from.fields[name]!, field) : field.nullable
    );
  }
  return JSON.stringify(from) === JSON.stringify(to);
}

/** Whether existing values remain valid in the destination field. */
function fieldAcceptsExistingValues(from: IdbRecordField, to: IdbRecordField): boolean {
  if (from.nullable && !to.nullable) return false;
  if (from.many !== to.many || from.dict !== to.dict) return false;
  if (!typeAcceptsExistingValues(from.type, to.type)) return false;
  if (from.valueSet === undefined) return to.valueSet === undefined;
  if (to.valueSet === undefined) return true;
  const destinationEnum = to.valueSet;
  return (
    from.valueSet.codecId === destinationEnum.codecId &&
    from.valueSet.members.every((oldMember) =>
      destinationEnum.members.some((member) => JSON.stringify(member.value) === JSON.stringify(oldMember.value))
    )
  );
}

/** Resolve literal defaults to the native value written by the record-transform runner. */
function storedLiteralDefault(
  field: IdbRecordField,
  value: string | number | boolean
): string | number | boolean | undefined {
  if (field.type.kind !== "scalar") return undefined;
  let stored: string | number | boolean;
  switch (field.type.codecId) {
    case "idb/decimal@1":
      // PSL supplies numbers for Decimal defaults; IDB's Decimal codec stores strings.
      if (typeof value !== "number" && typeof value !== "string") return undefined;
      stored = String(value);
      break;
    case "idb/string@1":
      if (typeof value !== "string") return undefined;
      stored = value;
      break;
    case "idb/bool@1":
      if (typeof value !== "boolean") return undefined;
      stored = value;
      break;
    case "idb/int32@1":
      if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)
        return undefined;
      stored = value;
      break;
    case "idb/double@1":
      if (typeof value !== "number") return undefined;
      stored = value;
      break;
    case "idb/json@1":
      stored = value;
      break;
    default:
      // Date, bigint, bytes and unknown codecs cannot be expressed by this JSON-literal operation.
      return undefined;
  }
  if (field.valueSet && !field.valueSet.members.some((member) => Object.is(member.value, stored))) return undefined;
  return stored;
}

/** Rejects unsupported types in stored metadata, including legacy source contracts. */
function assertSupportedRecordFields(fields: Record<string, IdbRecordField>, owner: string): void {
  for (const [name, field] of Object.entries(fields)) {
    if (field.type.kind === "union") {
      throw new Error(`${owner} field "${name}" uses a union type, which prisma-idb does not support`);
    }
    if (field.type.kind === "valueObject") {
      assertSupportedRecordFields(field.type.fields, `Value object "${field.type.name}"`);
    }
  }
}

/** Plans stored-record transformations after rejecting unsupported metadata. */
function diffRecordShapes(
  from: IdbSchemaDiffInput | null,
  to: IdbSchemaDiffInput,
  contract: Contract
): { ops: IdbDdlOp[]; conflicts: MigrationPlannerConflict[] } {
  for (const schema of [from, to]) {
    for (const store of Object.values(schema?.stores ?? {})) {
      if (store.record) assertSupportedRecordFields(store.record.fields, `Model "${store.record.model}"`);
    }
  }
  const ops: IdbDdlOp[] = [];
  const conflicts: MigrationPlannerConflict[] = [];
  for (const [storeName, store] of Object.entries(to.stores)) {
    const oldRecord = from?.stores[storeName]?.record;
    const newRecord = store.record;
    // New stores have no rows to backfill. Legacy DDL-only contracts carry no field history.
    if (oldRecord === undefined || newRecord === undefined) continue;
    const fields: Record<string, IdbValueTransform> = Object.create(null);
    const removeFields = Object.keys(oldRecord.fields).filter((name) => !Object.hasOwn(newRecord.fields, name));
    for (const [name, field] of Object.entries(newRecord.fields)) {
      const oldField = Object.hasOwn(oldRecord.fields, name) ? oldRecord.fields[name] : undefined;
      if (oldField !== undefined) {
        if (!fieldAcceptsExistingValues(oldField, field)) {
          // The runner rejects transforms that touch an existing primary key.
          if (keyPathFields(store.keyPath).some((key) => key === name || key.startsWith(`${name}.`))) {
            conflicts.push({
              kind: "keyFieldTransform",
              summary: `Cannot migrate incompatible key field "${name}" in store "${storeName}".`,
              why:
                `transformRecords cannot change key field "${name}". ` +
                "Author a manual migration that drops and re-creates the store with the desired data flow.",
            });
          } else {
            fields[name] = placeholder(`${newRecord.model}.${name}`);
          }
        }
        continue;
      }
      if (field.nullable) continue;
      const spec = contract.execution?.mutations?.defaults?.find(
        (entry) => entry.ref.table === storeName && entry.ref.column === name
      )?.onCreate;
      const value = spec?.params?.["value"];
      if (
        spec?.id !== "literal" ||
        value === null ||
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        field.many ||
        field.dict ||
        field.type.kind !== "scalar"
      ) {
        fields[name] = placeholder(`${newRecord.model}.${name}`);
        continue;
      }
      const stored = storedLiteralDefault(field, value);
      if (stored === undefined) {
        fields[name] = placeholder(`${newRecord.model}.${name}`);
        continue;
      }
      fields[name] = defaultIfMissing(stored);
    }
    if (Object.keys(fields).length > 0 || removeFields.length > 0) {
      ops.push(
        transformRecordsOp(storeName, {
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
          ...(removeFields.length > 0 ? { removeFields } : {}),
        })
      );
    }
  }
  return { ops, conflicts };
}

// ── Planner ───────────────────────────────────────────────────────────────────

/**
 * IDB migration planner.
 *
 * `plan()` converts `fromContract` and `contract` into `IdbSchemaDiffInput`s,
 * diffs their stores, indexes, and record shapes, and returns an
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

    const recordDiff = diffRecordShapes(fromSchema, toSchema, contract as Contract);
    if (recordDiff.conflicts.length > 0) return { kind: "failure", conflicts: recordDiff.conflicts };
    const ops = [...diffIdbSchema(fromSchema, toSchema), ...recordDiff.ops];

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
