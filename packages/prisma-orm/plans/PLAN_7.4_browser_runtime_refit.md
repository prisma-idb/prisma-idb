# Phase 7.4 — Browser runtime refit: walk `contractSpace.migrations`

**Status**: Not started
**Depends on**: 7.1 (no manifest types), 7.3 (new marker layout)
**Blocks**: 7.7 (app migration consumes the new API)

## Goal

Rewrite `createAutoMigratingIdbClient` so that:

1. Input is `contractSpace: ContractSpace<TContract>` — not a contract +
   optional manifest.
2. Migration computation happens **once, at design time**, in the form
   of the bundled `ops.json` blobs inside `contractSpace.migrations`.
3. The browser-side runtime **walks the chain** from the live marker
   to `contractSpace.headRef.hash`, applying each pending package's
   ops in sequence inside a single `upgradeneeded` callback.
4. The default policy is **safe** (`additive` + `widening` only).
   Destructive ops require explicit opt-in via `onDestructive: 'allow'`.
5. `IDBDatabase.onversionchange` is wired so that a tab at version N
   automatically closes when another tab opens at N+1.

After this phase, the browser bundle contains:

- ✅ The DDL applier (`applyOneDdlOp`, the `upgradeneeded` driver)
- ✅ The marker reader/writer
- ❌ The planner (gone — `IdbMigrationPlanner` no longer imported by client)
- ❌ The schema differ (gone — same reason)
- ❌ The live-DB schema introspection (gone — marker is the only state)

## Files to rewrite

### `packages/prisma-orm/client-idb/src/core/auto-migrate.ts` (rewrite)

The new file is roughly half the LOC of the current one. Sketch:

```ts
import type { Contract } from "@prisma-next/contract/types";
import type {
  ContractSpace,
  MigrationOperationClass,
  MigrationPackage,
  MigrationPlanOperation,
} from "@prisma-next/framework-components/control";
import { APP_SPACE_ID } from "@prisma-next/framework-components/control";
import type { IdbDdlOp } from "@prisma-next-idb/target-idb/migration";
import { isIdbDdlOp } from "@prisma-next-idb/target-idb/migration";
import type { IdbContract } from "./types";
import { createIdbClient, type IdbClient } from "./idb-client";

// ── Public policy types ───────────────────────────────────────────────

export interface MigrationPolicy {
  readonly allowedOperationClasses?: readonly MigrationOperationClass[];
  readonly onDestructive?: "refuse" | "allow";
}

const SAFE_POLICY: Required<MigrationPolicy> = {
  allowedOperationClasses: ["additive", "widening"],
  onDestructive: "refuse",
};

// ── Public API ────────────────────────────────────────────────────────

export interface AutoMigrateClientOptions<TContract extends IdbContract> {
  readonly contractSpace: ContractSpace<TContract>;
  readonly dbName: string;
  readonly policy?: MigrationPolicy;
  readonly factory?: IDBFactory; // for tests
}

export async function createAutoMigratingIdbClient<TContract extends IdbContract>(
  options: AutoMigrateClientOptions<TContract>
): Promise<IdbClient<TContract>> {
  const factory = options.factory ?? indexedDB;
  const policy = mergePolicy(options.policy);
  await autoMigrate({
    contractSpace: options.contractSpace,
    dbName: options.dbName,
    policy,
    factory,
  });
  // Pull the contract out of the contract space for the typed client.
  return createIdbClient({
    contract: options.contractSpace.contractJson,
    dbName: options.dbName,
  });
}

function mergePolicy(p?: MigrationPolicy): Required<MigrationPolicy> {
  return {
    allowedOperationClasses: p?.allowedOperationClasses ?? SAFE_POLICY.allowedOperationClasses,
    onDestructive: p?.onDestructive ?? SAFE_POLICY.onDestructive,
  };
}

// ── Core migration loop ───────────────────────────────────────────────

async function autoMigrate(input: {
  readonly contractSpace: ContractSpace<unknown>;
  readonly dbName: string;
  readonly policy: Required<MigrationPolicy>;
  readonly factory: IDBFactory;
}): Promise<void> {
  const { contractSpace, dbName, policy, factory } = input;
  const targetHash = contractSpace.headRef.hash;

  // Step 1: read current marker (and current version).
  const { currentVersion, markerHash } = await readMarker(dbName, factory);
  if (markerHash === targetHash) return;

  // Step 2: collect pending packages.
  const pendingOps = collectPendingOps({
    markerHash,
    headHash: targetHash,
    migrations: contractSpace.migrations,
  });

  // Step 3: apply policy.
  const filtered = applyPolicy(pendingOps, policy);
  if (filtered.length === 0 && pendingOps.length > 0) {
    // All ops filtered out — refuse if any was destructive.
    throw new Error(
      "Destructive migration refused: ops dropped by policy. " +
        "Pass `policy: { onDestructive: 'allow' }` to allow them."
    );
  }

  // Step 4: re-open at version + 1, apply DDL inside upgradeneeded.
  await openAndUpgrade({
    factory,
    dbName,
    targetVersion: currentVersion + 1,
    ops: filtered,
  });

  // Step 5: write the new marker.
  await writeMarker({ factory, dbName, space: APP_SPACE_ID, hash: targetHash });
}

function collectPendingOps(input: {
  readonly markerHash: string | null;
  readonly headHash: string;
  readonly migrations: readonly MigrationPackage[];
}): IdbDdlOp[] {
  // Walk migrations from markerHash → headHash via the metadata.from/to edges.
  // For a fresh DB (markerHash === null), start from the first migration
  // with `from === null`. Validate connectivity; throw if chain is broken.

  const byFrom = new Map<string | null, MigrationPackage>();
  for (const pkg of input.migrations) {
    byFrom.set(pkg.metadata.from ?? null, pkg);
  }

  const collected: IdbDdlOp[] = [];
  let cursor: string | null = input.markerHash;
  while (cursor !== input.headHash) {
    const next = byFrom.get(cursor);
    if (!next) {
      throw new Error(`Migration chain broken: no package with from === ${JSON.stringify(cursor)}`);
    }
    for (const op of next.ops) {
      if (!isIdbDdlOp(op)) {
        throw new Error(`Non-IDB op in migration package ${next.dirName}`);
      }
      collected.push(op);
    }
    cursor = next.metadata.to;
  }
  return collected;
}

function applyPolicy(ops: readonly IdbDdlOp[], policy: Required<MigrationPolicy>): IdbDdlOp[] {
  const allowed = new Set(policy.allowedOperationClasses);
  return ops.filter((op) => {
    if (allowed.has(op.operationClass)) return true;
    if (op.operationClass === "destructive" && policy.onDestructive === "allow") return true;
    return false;
  });
}
```

The actual DDL apply functions (`openAndUpgrade`, `applyOneDdlOp`)
should be **shared** with target-idb's runner — extract them into a
helper module that both consume, or import them via the
`@prisma-next-idb/target-idb/migration` entry point.

### `packages/prisma-orm/client-idb/src/core/idb-client.ts`

Add the `versionchange` handler. Currently the client opens the DB and
returns the connection; add:

```ts
db.onversionchange = () => {
  // Another tab is opening at a higher version — release the lock so
  // the upgrade can proceed. The runtime client is now stale; the
  // application layer can listen via `db.onclose` (or a custom event
  // we emit) to surface a "please reload" toast.
  db.close();
};
```

If the file already has an `open` helper, that's where this lives.
Find with:

```bash
rg "factory.open|indexedDB.open" packages/prisma-orm/client-idb/src
```

### `packages/prisma-orm/client-idb/src/exports/client-auto.ts`

Update the export to reflect the new API:

```ts
export {
  createAutoMigratingIdbClient,
  type AutoMigrateClientOptions,
  type MigrationPolicy,
} from "../core/auto-migrate";
```

Remove the `ManifestLike` export (deleted with the rewrite).

## Read-marker helper (new, in `auto-migrate.ts`)

```ts
async function readMarker(
  dbName: string,
  factory: IDBFactory
): Promise<{ currentVersion: number; markerHash: string | null }> {
  return new Promise((resolve) => {
    const req = factory.open(dbName); // no version → opens at current
    req.onsuccess = () => {
      const db = req.result;
      const version = db.version;

      if (!db.objectStoreNames.contains("_prisma_next_marker")) {
        db.close();
        resolve({ currentVersion: version, markerHash: null });
        return;
      }

      const tx = db.transaction("_prisma_next_marker", "readonly");
      const store = tx.objectStore("_prisma_next_marker");

      // First, try the new "app"-keyed record.
      const appReq = store.get(APP_SPACE_ID);
      appReq.onsuccess = () => {
        const rec = appReq.result as { storageHash?: string } | undefined;
        if (rec?.storageHash) {
          db.close();
          resolve({ currentVersion: version, markerHash: rec.storageHash });
          return;
        }
        // Fall back to legacy "default"-keyed record (one-time migration
        // from pre-7.3 IDB databases). If found, treat it as the "app"
        // marker — the next migration write will replace it.
        const legacyReq = store.get("default");
        legacyReq.onsuccess = () => {
          const legacy = legacyReq.result as { storageHash?: string } | undefined;
          db.close();
          resolve({ currentVersion: version, markerHash: legacy?.storageHash ?? null });
        };
        legacyReq.onerror = () => {
          db.close();
          resolve({ currentVersion: version, markerHash: null });
        };
      };
      appReq.onerror = () => {
        db.close();
        resolve({ currentVersion: version, markerHash: null });
      };
    };
    req.onerror = () => {
      // No DB yet — fresh install.
      resolve({ currentVersion: 0, markerHash: null });
    };
  });
}
```

Note the **legacy fallback**: when a "default"-keyed record exists
(from a pre-7.3 IDB database), we treat it as the "app" marker. The
next migration will write the new "app"-keyed record and the legacy
"default" record stays orphaned. Acceptable — IDB lets stale rows sit;
the next time someone resets the DB they'll be gone.

## Tests

### Rewrite `packages/prisma-orm/client-idb/test/auto-migrate.test.ts` (or whatever exists)

Test cases:

1. **Fresh DB**: contractSpace with one migration (from=null), no
   existing IDB. → DB opens with marker store + user stores, marker
   written with `space: 'app', storageHash: <head>`.
2. **Up-to-date DB**: contractSpace head matches existing marker. →
   No upgrade triggered (version stays the same), client opens
   immediately.
3. **One-step upgrade**: existing DB at hash A; contractSpace has
   migration A→B; head is B. → Walks one package, applies its ops,
   bumps marker to B.
4. **Multi-step upgrade**: existing DB at hash A; contractSpace has
   migrations A→B and B→C; head is C. → Walks both packages in order,
   applies their ops in one `upgradeneeded`, marker ends at C.
5. **Broken chain**: marker at hash X but no package with `from === X`. →
   Throws with a clear "migration chain broken" error.
6. **Policy refusal**: contractSpace has a destructive op, default
   policy. → Throws (or returns failure result — pick one style and
   stick to it).
7. **Policy allow**: same contractSpace, `policy: { onDestructive: 'allow' }`. →
   Applies the destructive op.
8. **Legacy "default" marker**: existing DB with `{ id: "default", ... }`. →
   Read as the "app" marker; next migration writes new record.
9. **`versionchange` handler**: open two connections; the second one
   opens at version+1; assert the first closes when `versionchange`
   fires.

Use `fake-indexeddb` as the factory in tests.

## Acceptance criteria

- [ ] `pnpm -F @prisma-next-idb/client-idb build` succeeds.
- [ ] `pnpm -F @prisma-next-idb/client-idb test` passes (rewritten suite).
- [ ] `rg "IdbMigrationPlanner|introspectLiveDb|ManifestLike" packages/prisma-orm/client-idb/src` returns no results.
- [ ] Bundle size for client-idb decreases (the planner no longer
      ships to the browser). Confirm by checking the built `dist/*.mjs`
      for `class IdbMigrationPlanner` (should be absent).

## Vendor cross-reference

- [`postgis/exports/control.ts`](../../../vendor/prisma-next/packages/3-extensions/postgis/src/exports/control.ts) — pattern for consuming `ContractSpace` from JSON imports.
- [`framework-components/control/control-migration-types.ts`](../../../vendor/prisma-next/packages/1-framework/1-core/framework-components/src/control/control-migration-types.ts) — full `MigrationOperationPolicy` shape we're mirroring.

## Bundle-size verification

After the rewrite:

```bash
pnpm -F @prisma-next-idb/client-idb build
rg "class Idb(MigrationPlanner|SchemaDiffer)" packages/prisma-orm/client-idb/dist
```

Should return nothing.
