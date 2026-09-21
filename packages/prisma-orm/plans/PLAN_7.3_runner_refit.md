# Phase 7.3 — Runner refit + manifest demolition + control-instance refusal

**Status**: Not started
**Depends on**: 7.1 (new types must exist)
**Blocks**: 7.4

## Goal

This phase is the **"CLI control plane has no IDB to talk to"** change,
viewed from three angles:

1. **Runner refit** — strip `target-idb/src/core/migration-runner.ts`
   to its single legitimate purpose: apply pre-computed `IdbDdlOp`s in
   an `upgradeneeded` callback. `executeAcrossSpaces` becomes a
   structured refusal.
2. **Manifest demolition** — delete `family-idb/src/core/manifest.ts`
   and `manifest-driver.ts` entirely. No CLI consumer remains after the
   control-instance refit.
3. **Control-instance refit** — convert
   `family-idb/src/core/control-instance.ts` methods (`verify`, `sign`,
   `readMarker`, `readAllMarkers`, `introspect`) to structured
   refusals. `verifySchema` (pure function over an in-memory `IdbSchemaIR`)
   stays — it doesn't depend on the manifest.

Plus the marker-shape adjustments:

- Marker key becomes `space` (defaults to `"app"`).
- Marker record carries the full `ContractMarkerRecord` field set.

(Note: scope adjustment from PLAN_7.1 — see scope note there.)

## Files to update

### `packages/prisma-orm/target-idb/src/core/migration-runner.ts`

**Delete**: lines 224-433 (the entire `buildSeedOps` helper + the
`executeAcrossSpaces` body that consumes it + the `fake-indexeddb`
import + the duck-typed manifest IO).

**Replace `executeAcrossSpaces` with**:

```ts
async executeAcrossSpaces(options: {
  readonly driver: ControlDriverInstance<"idb", "idb">;
  readonly perSpaceOptions: ReadonlyArray<MultiSpaceRunnerPerSpaceOptions<"idb", "idb">>;
}): Promise<MultiSpaceRunnerResult> {
  const failingSpace = options.perSpaceOptions[0]?.space ?? "app";
  return makeMultiNotOk({
    code: "IDB-RUNNER-CLI-UNSUPPORTED",
    summary:
      "IndexedDB migrations cannot be applied from the CLI.",
    why:
      "IndexedDB only exists in the browser; the CLI runs in Node.js. " +
      "There is no live database to apply ops against from this process. " +
      "Migrations apply automatically the next time a user opens the app " +
      "with createAutoMigratingIdbClient.",
    fix:
      "Run `prisma-next-idb preflight` to validate that the migration " +
      "chain applies cleanly against a fake-indexeddb shadow before " +
      "shipping.",
    failingSpace,
  });
}
```

(Error code `IDB-RUNNER-CLI-UNSUPPORTED` is new — add to whatever code
catalogue exists in `target-idb`, or just define it inline since we
don't have a structured error system yet.)

**Update marker write** at [migration-runner.ts:184-215](../target-idb/src/core/migration-runner.ts#L184-L215):

```ts
import type { ContractMarkerRecord } from "@prisma-next/contract/types";

// APP_SPACE_ID lives in framework-components/control
import { APP_SPACE_ID } from "@prisma-next/framework-components/control";

function writeMarker(
  db: IDBDatabase,
  marker: {
    readonly space: string;
    readonly storageHash: string;
    readonly profileHash?: string;
    readonly invariants?: readonly string[];
    readonly contractJson?: unknown;
    readonly canonicalVersion?: number | null;
    readonly appTag?: string | null;
    readonly meta?: Record<string, unknown>;
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains("_prisma_next_marker")) {
      resolve();
      return;
    }
    const tx = db.transaction("_prisma_next_marker", "readwrite");
    const store = tx.objectStore("_prisma_next_marker");
    const record: ContractMarkerRecord & { space: string } = {
      space: marker.space,
      storageHash: marker.storageHash,
      profileHash: marker.profileHash ?? "",
      updatedAt: new Date(),
      invariants: marker.invariants ?? [],
      contractJson: marker.contractJson ?? null,
      canonicalVersion: marker.canonicalVersion ?? null,
      appTag: marker.appTag ?? null,
      meta: marker.meta ?? {},
    };
    const putReq = store.put(record);
    putReq.onerror = () => reject(putReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

**Update `execute()` to pass `space` to `writeMarker`**:

The current code at [migration-runner.ts:476-499](../target-idb/src/core/migration-runner.ts#L476-L499)
extracts marker data from `destinationContract`. Add space resolution:

```ts
const markerData =
  storage !== undefined && typeof storage["storageHash"] === "string"
    ? {
        space: APP_SPACE_ID, // IDB is single-space for now
        storageHash: storage["storageHash"] as string,
        ...(typeof destContract?.["profileHash"] === "string"
          ? { profileHash: destContract["profileHash"] as string }
          : {}),
        // Future: when extensions land, the caller passes its own space ID.
      }
    : undefined;
```

### `packages/prisma-orm/target-idb/src/core/migration-factories.ts`

**Update `createMarkerStoreOp()`** to declare the keyPath as `"space"`
instead of `"id"`:

```ts
const MARKER_KEYPATH = "space"; // was "id"

export function createMarkerStoreOp(): CreateObjectStoreOp {
  return {
    kind: "createObjectStore",
    id: `object-store.${IDB_MARKER_STORE}.create`,
    label: `Create internal marker store "${IDB_MARKER_STORE}"`,
    operationClass: "additive" as MigrationOperationClass,
    storeName: IDB_MARKER_STORE,
    def: { keyPath: MARKER_KEYPATH },
  };
}
```

This is a **breaking change** for any existing IDB database created
under the old "default" keyPath layout. The migration-forward strategy
is handled in 7.4 (browser runtime reads the marker, and if it finds
a "default"-keyed record, ports it to "app").

### `packages/prisma-orm/target-idb/package.json`

Move `fake-indexeddb` from `dependencies` to `devDependencies` (it's
still used by tests, but not by the runner anymore):

```json
{
  "dependencies": {
    "@prisma-next/contract": "^0.11.0",
    "@prisma-next/framework-components": "^0.11.0",
    "@prisma-next/migration-tools": "^0.11.0",
    "pathe": "^2.0.3"
  },
  "devDependencies": {
    "fake-indexeddb": "^6.2.5",
    "tsdown": "^0.22.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.5"
  }
}
```

### `packages/prisma-orm/driver-idb/src/exports/runtime.ts` (only if affected)

The driver-idb has `MARKER_STORE_NAME` and `IdbMarkerRecord` exports.
If `IdbMarkerRecord` is shaped as `{ id, storageHash, ... }`, update
it to match the new `{ space, storageHash, ... }` shape.

Search:

```bash
rg "IdbMarkerRecord|MARKER_STORE_NAME" packages/prisma-orm
```

## Tests

### Update `packages/prisma-orm/target-idb/test/migration.test.ts`

- Drop tests that exercise the manifest read/write path inside
  `executeAcrossSpaces`.
- Add a test asserting `executeAcrossSpaces` returns the structured
  refusal regardless of inputs.
- Update marker-write tests: assert the record has `space: "app"` as
  the key, not `id: "default"`, and carries the full `ContractMarkerRecord`
  fields (invariants, contractJson, canonicalVersion, appTag, meta).
- Keep existing `execute()` tests — that path is unchanged except
  for marker shape.

### `packages/prisma-orm/family-idb/test/...`

No changes here in 7.3 — manifest tests are already gone from 7.1.
Verify with `pnpm -F @prisma-next-idb/family-idb test`.

## Acceptance criteria

- [ ] `pnpm -F @prisma-next-idb/target-idb build` succeeds.
- [ ] `pnpm -F @prisma-next-idb/target-idb test` passes.
- [ ] `rg "fake-indexeddb" packages/prisma-orm/target-idb/src` returns
      no results.
- [ ] `rg "readManifest|writeManifest" packages/prisma-orm/target-idb/src`
      returns no results.
- [ ] `executeAcrossSpaces` test confirms structured refusal returned
      for any input.
- [ ] Marker record schema: keyed by `space`, contains all 8
      `ContractMarkerRecord` fields.

## Vendor cross-reference

- [SQL family runner](../../../vendor/prisma-next/packages/2-sql/9-family/src/core/migrations/runner.ts) — how `executeAcrossSpaces` is implemented for a target that **does** support CLI apply; our refusal is the IDB-target analogue.
- ADR 021 (referenced in feedback) — explains the per-space marker decision in SQL family; we adopt the same layout proactively.

## Interlock with 7.1

As noted in PLAN_7.1, the duck-typed manifest block in this file
breaks the type-check the moment 7.1's manifest deletion lands.
**Ship 7.1+7.3 together** (or in immediate succession with no other
commits between) so the build stays green.
