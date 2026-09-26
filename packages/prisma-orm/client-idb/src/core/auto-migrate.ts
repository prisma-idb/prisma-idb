import type { Contract } from "@prisma/orm-framework/contract/types";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { APP_SPACE_ID } from "@prisma/orm-framework/components/control";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
// Browser-safe (WebCrypto) hash — the framework's `@prisma/orm-toolchain/migration-tools/hash`
// uses `node:crypto` and throws in the browser (PLAN Issue #23 regression).
import { computeMigrationHash } from "./migration-hash";
// Import from `./runtime` (not `./migration`) so `MigrationCLI` → `node:fs`
// is not bundled into the browser client.
import { isIdbDdlOp, openAndUpgrade, readMarker, type IdbDdlOp } from "@prisma-idb/target-idb/runtime";
import { createIdbClient, type IdbClient } from "./idb-client";
import type { IdbContract } from "./types";

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Options for {@link createAutoMigratingIdbClient}.
 *
 * `contractSpace` is the bundled artefact produced at design time by
 * `prisma-idb migration contract-space`. It carries the canonical
 * contract JSON, the ordered list of migration packages, and the head
 * ref the runtime walks toward.
 *
 * `extensions` is an optional list of additional contract spaces contributed
 * by IDB extensions (e.g. the sync extension). Each extension space migrates
 * independently of the application space and writes its own marker row keyed
 * by the extension's `spaceId`.
 */
export interface AutoMigrateClientOptions<TContract extends IdbContract> {
  readonly contractSpace: ContractSpace<TContract>;
  readonly dbName: string;
  /** IDB factory override — primarily for tests. Defaults to `indexedDB`. */
  readonly factory?: IDBFactory;
  /**
   * Additional contract spaces from IDB extensions.
   *
   * Every space with pending work — the application space plus each
   * extension — is applied together in one `upgradeneeded` transaction,
   * which also writes every space's marker. Each space still gets its own
   * marker row in `_prisma_next_marker`.
   */
  readonly extensions?: ReadonlyArray<IdbExtensionSpace>;
}

/**
 * Create a typed IDB client, applying any pending migrations from the bundled
 * `contractSpace` first.
 *
 * **What runs**:
 *
 * 1. Open the database at the current local version, read the marker from
 *    `_prisma_next_marker`. (Null for a fresh database)
 * 2. If the marker hash equals `contractSpace.headRef.hash`, the database
 *    is already at the target — return the client immediately.
 * 3. Otherwise, walk `contractSpace.migrations` from the marker hash (or
 *    `null` for fresh) to `headRef.hash`, collecting each pending
 *    package's `ops` in chain order.
 * 4. If `extensions` are configured, repeat steps 1–3 for each extension
 *    space, then combine every space's pending ops into ONE reopen at
 *    `db.version + 1` so `upgradeneeded` fires once; apply every collected
 *    op (all spaces) inside that single version-change transaction, which
 *    also writes every migrated space's marker.
 * 5. Hand back the typed `IdbClient`.
 *
 * Every pending op is applied exactly as planned, destructive ones included.
 * The developer reviewed them when running `prisma-idb migration plan`,
 * which warns about any that delete data. Skipping some ops would leave the
 * database claiming a schema it doesn't have, and refusing them would stop
 * the app from opening for every user.
 *
 * **What does NOT run in the browser**:
 *
 * The planner does not ship to the browser. The differ does not run. Live-DB
 * schema introspection does not happen. All the planning was done once at
 * design time and is encoded in the bundled `ops.json` blobs inside
 * `contractSpace.migrations`.
 *
 * @example
 * ```ts
 * import { createAutoMigratingIdbClient } from '@prisma-idb/client-idb/client-auto';
 * import { contractSpace } from './prisma/contract-space.generated';
 *
 * const db = await createAutoMigratingIdbClient({ contractSpace, dbName: 'my-app' });
 * const users = await db.orm.users.all().toArray();
 * ```
 */
export async function createAutoMigratingIdbClient<TContract extends IdbContract>(
  options: AutoMigrateClientOptions<TContract>
): Promise<IdbClient<TContract>> {
  const factory = options.factory ?? indexedDB;

  await autoMigrate({
    // The public `AutoMigrateClientOptions<TContract>` is generic over the
    // user's narrow IDB contract; the internal `autoMigrate` only consumes
    // chain-walking fields, so widen to `ContractSpace<Contract>` here.
    contractSpace: options.contractSpace as unknown as ContractSpace<Contract>,
    dbName: options.dbName,
    factory,
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
  });

  return createIdbClient({
    contract: options.contractSpace.contractJson,
    dbName: options.dbName,
    factory,
  });
}

// ── Core migration loop ──────────────────────────────────────────────────────

/**
 * The migration loop. Exported for tests.
 *
 * Collects pending ops from the app space and every extension space, then
 * applies all of them in a single `upgradeneeded` transaction (one IDB
 * version bump total). The same transaction writes the marker of every
 * space that migrated, so schema changes and markers commit together.
 *
 * @internal Prefer {@link createAutoMigratingIdbClient}.
 */
export async function autoMigrate(input: {
  // `ContractSpace<Contract>` instead of `<unknown>` so the generic
  // constraint `TContract extends Contract` from the framework is satisfied.
  // The internal apply path only reads `headRef.hash` and `migrations`, so
  // the precise contract shape inside `contractJson` doesn't matter here.
  readonly contractSpace: ContractSpace<Contract>;
  readonly dbName: string;
  readonly factory: IDBFactory;
  readonly extensions?: ReadonlyArray<IdbExtensionSpace>;
}): Promise<void> {
  const { dbName, factory } = input;

  // Order here only affects the collection loop below, not the final apply
  // order (see the combined-apply step, which re-sorts to match upstream
  // ADR 212's extension-first convention).
  const spaces: Array<{ spaceId: string; contractSpace: ContractSpace<Contract> }> = [
    { spaceId: APP_SPACE_ID, contractSpace: input.contractSpace },
    ...(input.extensions ?? []),
  ];

  // Reject reserved/duplicate extension space IDs before touching the
  // database. Without this, two extensions sharing a spaceId would combine
  // their pending DDL and the upgrade would try to create the same stores
  // twice; an extension using APP_SPACE_ID would have its marker write
  // silently overwrite (or be overwritten by) the app space's marker.
  const seenSpaceIds = new Set<string>();
  for (const extension of input.extensions ?? []) {
    if (extension.spaceId === APP_SPACE_ID || seenSpaceIds.has(extension.spaceId)) {
      throw new Error(`Invalid duplicate or reserved extension space ID: "${extension.spaceId}"`);
    }
    seenSpaceIds.add(extension.spaceId);
  }

  // Descriptor self-consistency (upstream ADR 212): a space's pinned headRef
  // must match the hash actually embedded in its contractJson. Catches an
  // extension author who edited the contract source without regenerating
  // migrations/refs/head.json — fails loudly here instead of surfacing as a
  // confusing chain-walk error deep inside walkChain.
  for (const space of spaces) {
    const declaredHash = space.contractSpace.contractJson.storage.storageHash;
    const headHash = space.contractSpace.headRef.hash;
    if (declaredHash !== headHash) {
      throw new Error(
        `Contract space "${space.spaceId}" is internally inconsistent: ` +
          `contractJson.storage.storageHash (${declaredHash}) does not match ` +
          `headRef.hash (${headHash}). The contract source likely changed without ` +
          "regenerating migrations/refs/head.json for this space — rebuild its migration chain."
      );
    }
  }

  // Read current DB version once (all spaces share the same IDB database).
  const { currentVersion: initialVersion } = await openAndReadMarker(dbName, factory, APP_SPACE_ID);

  // Collect pending work per space without applying yet, so a broken chain in
  // any space fails before the database is touched.
  const pendingPerSpace: Array<{ spaceId: string; ops: IdbDdlOp[]; storageHash: string }> = [];

  for (const space of spaces) {
    const targetHash = space.contractSpace.headRef.hash;
    const { markerHash } = await openAndReadMarker(dbName, factory, space.spaceId);
    if (markerHash === targetHash) continue;

    const pendingOps = await walkChain({
      markerHash,
      headHash: targetHash,
      migrations: space.contractSpace.migrations,
    });
    // Push whenever the marker is behind `targetHash` — even if every package
    // walked had zero ops (a hash-only "bridge" migration, e.g. re-emitting
    // the contract under a new hashing algorithm with no structural change).
    // Gating on `pendingOps.length > 0` here would skip the marker write
    // below for that space, and since nothing ever changes on a later
    // retry either, the marker gets stuck at the old hash forever — the
    // space never converges to `targetHash`, even though there was never
    // any actual work to do.
    pendingPerSpace.push({ spaceId: space.spaceId, ops: pendingOps, storageHash: targetHash });
  }

  if (pendingPerSpace.length === 0) return;

  // Combine every pending space into ONE upgradeneeded transaction (one IDB
  // version bump total), which also writes every space's marker. A failure
  // partway through rolls back all spaces' schema changes and markers, and a
  // multi-tab user hits one versionchange/blocked cycle on cold start instead
  // of one per space.
  //
  // DDL op order is extensions (alphabetical by spaceId) first, app space
  // last, matching upstream ADR 212's convention. That's safe even though the
  // app space creates `_prisma_next_marker`: openAndUpgrade writes the
  // markers only after every op has run.
  const orderedPending = [...pendingPerSpace].sort((a, b) => {
    if (a.spaceId === APP_SPACE_ID) return 1;
    if (b.spaceId === APP_SPACE_ID) return -1;
    return a.spaceId.localeCompare(b.spaceId);
  });

  await openAndUpgrade({
    factory,
    dbName,
    targetVersion: initialVersion + 1,
    ops: orderedPending.flatMap((space) => space.ops),
    markers: orderedPending.map((space) => ({ space: space.spaceId, storageHash: space.storageHash })),
  });
}

/**
 * Walk the migration chain from `markerHash` (or `null` for a fresh DB) to
 * `headHash`, collecting every pending package's ops in order.
 *
 * Throws on chain discontinuity (no package whose `from === cursor`) so
 * misconfigured `contractSpace` inputs fail loudly rather than silently
 * leaving the DB at an intermediate state.
 */
async function walkChain(input: {
  readonly markerHash: string | null;
  readonly headHash: string;
  readonly migrations: readonly MigrationPackage[];
}): Promise<IdbDdlOp[]> {
  const byFrom = new Map<string | null, MigrationPackage>();
  for (const pkg of input.migrations) {
    byFrom.set(pkg.metadata.from, pkg);
  }

  const pendingOps: IdbDdlOp[] = [];
  let cursor: string | null = input.markerHash;
  const visited = new Set<string | null>();

  while (cursor !== input.headHash) {
    if (visited.has(cursor)) {
      throw new Error(
        `Auto-migration chain contains a cycle at hash ${JSON.stringify(cursor)}. ` +
          "Re-run `prisma-idb migration contract-space` to rebuild a valid chain."
      );
    }
    visited.add(cursor);
    const next = byFrom.get(cursor);
    if (!next) {
      throw new Error(
        `Auto-migration chain broken: no migration package with from === ${JSON.stringify(cursor)}. ` +
          "Verify that contract-space.generated.ts is up to date by re-running " +
          "`prisma-idb migration contract-space`."
      );
    }
    const computedHash = await computeMigrationHash(next.metadata, next.ops);
    if (computedHash !== next.metadata.migrationHash) {
      throw new Error(
        `Migration package "${next.dirName}" failed integrity check: ` +
          `stored migrationHash ${next.metadata.migrationHash} does not match ` +
          `computed hash ${computedHash}. ` +
          "The ops may have been edited after the package was generated. " +
          "Re-run `prisma-idb migration plan` to regenerate the package."
      );
    }
    for (const op of next.ops) {
      if (!isIdbDdlOp(op)) {
        throw new Error(`Non-IDB operation found in migration package ${next.dirName}: ${JSON.stringify(op)}`);
      }
      pendingOps.push(op);
    }
    cursor = next.metadata.to;
  }

  return pendingOps;
}

/**
 * Open the database at its current local version (no version arg), read the
 * marker for `spaceId`, then close the connection. Returns the current integer
 * version so the caller can compute `currentVersion + 1` for the upgrade re-open.
 */
function openAndReadMarker(
  dbName: string,
  factory: IDBFactory,
  spaceId: string
): Promise<{ currentVersion: number; markerHash: string | null }> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(dbName);
    } catch (err) {
      reject(err);
      return;
    }

    req.onsuccess = () => {
      const db = req.result;
      const currentVersion = db.version;
      void (async () => {
        try {
          const record = await readMarker(db, spaceId);
          resolve({ currentVersion, markerHash: record?.storageHash ?? null });
        } catch (err) {
          reject(err);
        } finally {
          db.close();
        }
      })();
    };
    req.onerror = () => {
      reject(req.error ?? new Error(`IDB open failed while reading marker for "${dbName}"`));
    };
  });
}
