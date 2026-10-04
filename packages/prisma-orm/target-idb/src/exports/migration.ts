/**
 * @prisma-idb/target-idb/migration
 *
 * Public API for authoring and executing IDB migration files.
 *
 * **For migration file authors** — import the base class, CLI entrypoint,
 * and DDL op factories together:
 * ```ts
 * import {
 *   Migration,
 *   MigrationCLI,
 *   createObjectStoreOp,
 *   createIndexOp,
 * } from "@prisma-idb/target-idb/migration";
 *
 * export default class M extends Migration {
 *   override describe() { return { from: null, to: "..." }; }
 *   override get operations() {
 *     return [createObjectStoreOp("users", { keyPath: "id" })];
 *   }
 * }
 *
 * MigrationCLI.run(import.meta.url, M);
 * ```
 *
 * The planner generates operations at build time. Apply them in the browser
 * with `createAutoMigratingIdbClient` from client-idb. The framework's CLI
 * migration runner returns `IDB-RUNNER-CLI-UNSUPPORTED`.
 */

// ── DDL factory functions ─────────────────────────────────────────────────────

export {
  createObjectStoreOp,
  dropObjectStoreOp,
  createIndexOp,
  dropIndexOp,
  isIdbDdlOp,
  deletedDataWarning,
} from "../core/migration-factories";

export type {
  IdbDdlOp,
  CreateObjectStoreOp,
  DropObjectStoreOp,
  CreateIndexOp,
  DropIndexOp,
} from "../core/migration-factories";

// ── Schema diffing ────────────────────────────────────────────────────────────

export type { IdbSchemaDiffInput } from "../core/schema-diff";
export { diffIdbSchema } from "../core/schema-diff";

// ── Planner & runner ──────────────────────────────────────────────────────────

export { IdbMigrationRunner } from "../core/migration-runner";
export { IdbMigrationPlanner, contractToIdbSchema, renderMigrationTs } from "../core/migration-planner";
export type { IdbMigrationPlanWithAuthoring } from "../core/migration-planner";

// ── DDL apply helpers (shared by client-idb auto-migrate + family-idb preflight) ──

export { applyOneDdlOp, openAndUpgrade, readMarker, writeMarker, writeMarkers } from "../core/apply-ddl-op";
export type { IdbMarkerRecord, MarkerWriteInput } from "../core/apply-ddl-op";

// ── Migration authoring surface (base class + self-emit CLI) ──────────────────

/**
 * The base class every user-authored IDB migration extends. Aliased to
 * `Migration` so rendered scaffolds read as `class M extends Migration {…}`
 * — identical to vendor's Postgres/Mongo authoring surfaces.
 */
export { IdbMigration as Migration } from "../core/idb-migration";

/**
 * Self-emit entrypoint for `node migration.ts`. Always the last line of a
 * rendered migration file. Re-emits `ops.json` + `migration.json` based on
 * the migration class's current `operations` and `describe()`.
 */
export { MigrationCLI } from "../core/migration-cli";
