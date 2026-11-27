import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { APP_SPACE_ID } from "@prisma/orm-framework/components/control";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
// Browser-safe (WebCrypto) hash — the framework's `@prisma/orm-toolchain/migration-tools/hash`
// uses `node:crypto`, which is unavailable in the browser.
import { computeMigrationHash } from "./migration-hash";
// Import from `./runtime` (not `./migration`) so `MigrationCLI` → `node:fs`
// is not bundled into the browser client.
import {
  IDB_MARKER_STORE,
  isIdbDdlOp,
  openAndUpgrade,
  type IdbMarkerRecord,
  type IdbDdlOp,
  type TransformRecordsOp,
} from "@prisma-idb/target-idb/runtime";
import { createIdbClient, type IdbClient } from "./idb-client";
import { getStoreName, type IdbContract } from "./types";

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
 * 1. Read all applied markers from `_prisma_next_marker` in one transaction.
 * 2. Collect pending packages for each space behind its head. When an upgrade
 *    is needed, recover the applied store names of every configured space.
 * 3. Recheck the applied markers and validate ownership against the live store
 *    names inside `upgradeneeded`. Apply extensions in space-ID order, then the
 *    app. Write all new markers
 *    in the same transaction.
 * 4. Return the typed client.
 *
 * The browser replays the bundled operations. Those operations can delete
 * stores and rows. The CLI warns about data loss when it plans a migration.
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
  readonly contractSpace: ContractSpace<Contract>;
  readonly dbName: string;
  readonly factory: IDBFactory;
  readonly extensions?: ReadonlyArray<IdbExtensionSpace>;
}): Promise<void> {
  const { dbName, factory } = input;

  const spaces = resolveContractSpaces(input.contractSpace, input.extensions ?? []);
  const destinationOwners = new Map<string, string>([[IDB_MARKER_STORE, APP_SPACE_ID]]);
  for (const { spaceId, contractSpace } of spaces) {
    for (const storeName of declaredStores(contractSpace)) recordStoreOwner(destinationOwners, storeName, spaceId);
  }

  const { currentVersion, markers: appliedMarkers } = await openAndReadMarkers(dbName, factory);
  const hasVerifiedSchemaVersion = [...appliedMarkers.values()].some(
    (marker) => marker.meta?.["idbDatabaseVersion"] === currentVersion
  );
  const pendingPerSpace: Array<{ spaceId: string; ops: IdbDdlOp[]; storageHash: string }> = [];

  for (const { spaceId, contractSpace } of spaces) {
    const targetHash = contractSpace.headRef.hash;
    const markerHash = appliedMarkers.get(spaceId)?.storageHash ?? null;
    if (markerHash === targetHash) continue;

    const pendingOps = await walkChain({
      markerHash,
      headHash: targetHash,
      migrations: contractSpace.migrations,
    });
    // Push whenever the marker is behind `targetHash` — even if every package
    // walked had zero ops (a hash-only "bridge" migration, e.g. re-emitting
    // the contract under a new hashing algorithm with no structural change).
    // Gating on `pendingOps.length > 0` here would skip the marker write
    // below for that space, and since nothing ever changes on a later
    // retry either, the marker gets stuck at the old hash forever — the
    // space never converges to `targetHash`, even though there was never
    // any actual work to do.
    pendingPerSpace.push({ spaceId, ops: pendingOps, storageHash: targetHash });
  }

  if (pendingPerSpace.length === 0) return;

  const appliedOwners = new Map<string, string>([[IDB_MARKER_STORE, APP_SPACE_ID]]);
  for (const { spaceId, contractSpace } of spaces) {
    const markerHash = appliedMarkers.get(spaceId)?.storageHash;
    if (markerHash === undefined) continue;
    if (markerHash === contractSpace.headRef.hash) {
      for (const storeName of declaredStores(contractSpace)) recordStoreOwner(appliedOwners, storeName, spaceId);
    }
    if (contractSpace.migrations.length > 0) {
      // Applied migrations can leave helper stores outside the declared contract.
      for (const storeName of await storesAtMarker(contractSpace, markerHash)) {
        recordStoreOwner(appliedOwners, storeName, spaceId);
      }
    }
  }

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

  const schedule = orderedPending.flatMap(({ spaceId, ops }) => ops.map((op) => ({ spaceId, op })));
  const configuredSpaceIds = new Set(spaces.map(({ spaceId }) => spaceId));
  const hasUnconfiguredMarker = [...appliedMarkers.keys()].some((spaceId) => !configuredSpaceIds.has(spaceId));
  const recoverableOwners = hasUnconfiguredMarker ? new Map() : replayStoreOwners(destinationOwners, schedule);
  const onAppTransform = createTransformRecordsCallback(input.contractSpace.contractJson, input.extensions ?? []);
  let operationIndex = -1;
  let upgraded = false;
  const markerMeta: Record<string, number> = {};
  await openAndUpgrade({
    factory,
    dbName,
    targetVersion: currentVersion + 1,
    ops: schedule.map(({ op }) => op),
    markers: orderedPending.map(({ spaceId, storageHash }) => ({
      space: spaceId,
      storageHash,
      meta: markerMeta,
    })),
    onUpgradeStart(storeNames, previousVersion, liveMarkers) {
      if (previousVersion !== currentVersion) {
        throw new Error("The IndexedDB version changed while planning an upgrade. Open the client again.");
      }
      if (!sameMigrationMarkers(appliedMarkers, liveMarkers)) {
        throw new Error("The IndexedDB migration markers changed while planning an upgrade. Open the client again.");
      }
      validateStoreOwnership(
        new Set(Array.from(storeNames)),
        appliedOwners,
        destinationOwners,
        schedule,
        recoverableOwners,
        hasVerifiedSchemaVersion
      );
      // An unrelated upgrade cannot establish the ownership of old live stores.
      if (hasVerifiedSchemaVersion || storeNames.length === 0) {
        markerMeta["idbDatabaseVersion"] = currentVersion + 1;
      }
      upgraded = true;
    },
    onOperationStart() {
      operationIndex += 1;
    },
    onTransformRecords(tx, op, onDone) {
      if (schedule[operationIndex]?.spaceId === APP_SPACE_ID) onAppTransform(tx, op, onDone);
      else onDone();
    },
  });
  if (!upgraded) {
    // Another opener can reach the requested version before this request runs.
    const { markers: applied } = await openAndReadMarkers(dbName, factory);
    if (spaces.some(({ spaceId, contractSpace }) => applied.get(spaceId)?.storageHash !== contractSpace.headRef.hash)) {
      throw new Error("Another client upgraded IndexedDB to different contract spaces. Open the client again.");
    }
  }
}

/**
 * Build the `openAndUpgrade` callback that runs extension hooks after a `transformRecords` op.
 * Hooks see app model names. App operations on stores absent from the destination contract skip the hooks.
 */
function createTransformRecordsCallback(contract: Contract, extensions: ReadonlyArray<IdbExtensionSpace>) {
  const models = Object.keys(domainModelsAtDefaultNamespace(contract.domain));
  const hooks = extensions.flatMap((extension) => (extension.onTransformRecords ? [extension.onTransformRecords] : []));
  return (tx: IDBTransaction, op: TransformRecordsOp, onDone: (error?: unknown) => void): void => {
    const modelName = models.find((model) => getStoreName(contract as IdbContract, model) === op.storeName);
    if (modelName === undefined) {
      onDone();
      return;
    }
    /** Run extension hooks in order inside the active upgrade transaction. */
    const runHook = (index: number): void => {
      const hook = hooks[index];
      if (!hook) {
        onDone();
        return;
      }
      let completed = false;
      /** Settle each hook once so a duplicate callback cannot advance the upgrade twice. */
      const next = (error?: unknown): void => {
        if (completed) return;
        completed = true;
        if (error === undefined) runHook(index + 1);
        else onDone(error);
      };
      try {
        hook(tx, op, modelName, next);
      } catch (error) {
        next(error);
      }
    };
    runHook(0);
  };
}

function declaredStores(contractSpace: ContractSpace<Contract>): string[] {
  const { stores } = contractSpace.contractJson.storage as IdbContract["storage"];
  return Object.keys(stores ?? {});
}

/** Recover a space's store names by replaying the structural ops up to its marker. */
async function storesAtMarker(contractSpace: ContractSpace<Contract>, markerHash: string): Promise<Set<string>> {
  const stores = new Set<string>();
  const applied = await walkChain({
    markerHash: null,
    headHash: markerHash,
    migrations: contractSpace.migrations,
    appliedHistory: true,
  });
  for (const op of applied) {
    if (op.kind === "createObjectStore") stores.add(op.storeName);
    if (op.kind === "dropObjectStore") stores.delete(op.storeName);
  }
  return stores;
}

/** Identify stores that only one space could have created before its marker was written. */
function replayStoreOwners(
  destinationOwners: ReadonlyMap<string, string>,
  schedule: readonly { spaceId: string; op: IdbDdlOp }[]
): ReadonlyMap<string, string | null> {
  const owners = new Map<string, string | null>(destinationOwners);
  for (const {
    spaceId,
    op: { storeName },
  } of schedule) {
    const owner = owners.get(storeName);
    owners.set(storeName, owner === undefined || owner === spaceId ? spaceId : null);
  }
  return owners;
}

/** Follow ownership in apply order before any operation can read or change a store. */
function validateStoreOwnership(
  liveStores: Set<string>,
  owners: Map<string, string>,
  destinationOwners: ReadonlyMap<string, string>,
  schedule: readonly { spaceId: string; op: IdbDdlOp }[],
  recoverableOwners: ReadonlyMap<string, string | null>,
  hasVerifiedSchemaVersion: boolean
): void {
  // A legacy client could finish the DDL and stop before writing its markers.
  // Record a live name's initial owner so replays cannot silently drop a store
  // that might already hold the next space's rows.
  const initialOwners = hasVerifiedSchemaVersion ? undefined : new Map(owners);
  const initiallyLive = hasVerifiedSchemaVersion ? undefined : new Set(liveStores);
  for (const {
    spaceId,
    op: { kind, storeName },
  } of schedule) {
    const owner = owners.get(storeName);
    const replayingCreate = kind === "createObjectStore" && recoverableOwners.get(storeName) === spaceId;
    if (owner === undefined && liveStores.has(storeName) && !replayingCreate) {
      throw new Error(
        `Cannot migrate contract space ${JSON.stringify(spaceId)}: existing store ${JSON.stringify(storeName)} has no owner at the applied migration markers.`
      );
    }
    if (owner !== undefined || kind === "createObjectStore") recordStoreOwner(owners, storeName, spaceId);
    if (kind === "createObjectStore") {
      const initialOwner = initialOwners?.get(storeName);
      if (initialOwner !== undefined && initialOwner !== spaceId && initiallyLive?.has(storeName)) {
        throw new Error(
          `Cannot transfer existing store ${JSON.stringify(storeName)} with older migration markers. ` +
            "Verify which space owns its rows before continuing the migration."
        );
      }
      liveStores.add(storeName);
    }
    if (kind === "dropObjectStore") {
      owners.delete(storeName);
      liveStores.delete(storeName);
    }
  }

  for (const [storeName, spaceId] of destinationOwners) {
    if (owners.get(storeName) !== spaceId || !liveStores.has(storeName)) {
      throw new Error(
        `Migration for contract space ${JSON.stringify(spaceId)} would leave its declared store ${JSON.stringify(storeName)} missing or owned by another space.`
      );
    }
  }
}

/** Stores belong to one space because every space shares the same IndexedDB database. */
function recordStoreOwner(owners: Map<string, string>, storeName: string, spaceId: string): void {
  const owner = owners.get(storeName);
  if (owner === undefined) owners.set(storeName, spaceId);
  else if (owner !== spaceId) {
    throw new Error(
      `Store ${JSON.stringify(storeName)} is used by contract spaces ${JSON.stringify(owner)} and ${JSON.stringify(spaceId)}. ` +
        "Give each store a name unique to its contract space."
    );
  }
}

/** Validates bundled descriptors before the migration loop opens the database. */
function resolveContractSpaces(
  contractSpace: ContractSpace<Contract>,
  extensions: ReadonlyArray<IdbExtensionSpace>
): Array<{ spaceId: string; contractSpace: ContractSpace<Contract> }> {
  // Validate and collect app-first. The combined upgrade applies extensions
  // first, matching upstream ADR 212.
  const spaces: Array<{ spaceId: string; contractSpace: ContractSpace<Contract> }> = [
    { spaceId: APP_SPACE_ID, contractSpace },
    ...extensions,
  ];

  // Reject reserved/duplicate extension space IDs before touching the
  // database. Without this, two extensions sharing a spaceId would combine
  // their pending DDL and the upgrade would try to create the same stores
  // twice; an extension using APP_SPACE_ID would have its marker write
  // silently overwrite (or be overwritten by) the app space's marker.
  const seenSpaceIds = new Set<string>();
  for (const extension of extensions) {
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

  return spaces;
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
  readonly appliedHistory?: true;
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
    // Already-applied packages can carry the older SHA-256 prefix.
    const storedHash = next.metadata.migrationHash;
    const expectedHash = input.appliedHistory ? storedHash.replace(/^sha256:/, "") : storedHash;
    if (computedHash !== expectedHash) {
      throw new Error(
        `Migration package "${next.dirName}" failed integrity check: ` +
          `stored migrationHash ${storedHash} does not match ` +
          `computed hash ${computedHash}. ` +
          "Restore the correct migration.json and ops.json for this package. " +
          "Run `prisma-idb migration contract-space` to rebuild an app bundle. For a packaged extension, reinstall the package with the correct migration."
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

/** Compare the marker fields that affect migration planning, including unconfigured spaces. */
function sameMigrationMarkers(
  expected: ReadonlyMap<string, IdbMarkerRecord>,
  live: readonly IdbMarkerRecord[]
): boolean {
  return (
    expected.size === live.length &&
    live.every(({ space, storageHash, meta }) => {
      const marker = expected.get(space);
      return (
        marker !== undefined &&
        marker.storageHash === storageHash &&
        marker.meta?.["idbDatabaseVersion"] === meta?.["idbDatabaseVersion"]
      );
    })
  );
}

/** Read all spaces' markers while holding one connection at the same database version. */
function openAndReadMarkers(
  dbName: string,
  factory: IDBFactory
): Promise<{
  currentVersion: number;
  markers: ReadonlyMap<string, IdbMarkerRecord>;
}> {
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      const currentVersion = db.version;
      void (async () => {
        try {
          const markers = await readMigrationMarkers(db);
          resolve({ currentVersion, markers: new Map(markers.map((marker) => [marker.space, marker])) });
        } catch (error) {
          reject(error);
        } finally {
          db.close();
        }
      })();
    };
    req.onerror = () => {
      reject(req.error ?? new Error(`IDB open failed while reading markers for "${dbName}"`));
    };
  });
}

/** Read all marker rows in one transaction, including markers for omitted extensions. */
function readMigrationMarkers(db: IDBDatabase): Promise<IdbMarkerRecord[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(IDB_MARKER_STORE)) {
      resolve([]);
      return;
    }
    const request = db.transaction(IDB_MARKER_STORE).objectStore(IDB_MARKER_STORE).getAll();
    request.onsuccess = () => resolve(request.result as IdbMarkerRecord[]);
    request.onerror = () => reject(request.error ?? new Error("Failed to read IndexedDB migration markers."));
  });
}
