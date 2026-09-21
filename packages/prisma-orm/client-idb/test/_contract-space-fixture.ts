/**
 * Test helper: build an in-memory `ContractSpace` from a sequence of
 * contracts (the chain of versions a user would evolve through).
 *
 * Uses `IdbMigrationPlanner` at test-setup time to compute the ops for
 * each `from → to` transition, then wraps them in `MigrationPackage`
 * shapes the way `prisma-idb migration contract-space` would in a
 * real project.
 */

import type { Contract } from "@prisma/orm-framework/contract/types";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";

function getStorageHash(contract: unknown): string {
  return (contract as { storage: { storageHash: string } }).storage.storageHash;
}

/**
 * Build a `ContractSpace` from an ordered list of contract versions
 * (`[v1, v2, v3, ...]`). The space's `migrations` array has one package
 * per transition (`null → v1`, `v1 → v2`, …); `headRef.hash` points at
 * the last version's storage hash.
 */
export function buildContractSpaceFixture<TContract extends Contract>(
  versions: readonly TContract[]
): ContractSpace<TContract> {
  if (versions.length === 0) {
    throw new Error("buildContractSpaceFixture requires at least one contract version");
  }

  const planner = new IdbMigrationPlanner();
  const migrations: MigrationPackage[] = [];

  let previous: TContract | null = null;
  let index = 0;
  for (const current of versions) {
    const planResult = planner.plan({
      contract: current,
      schema: null,
      policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
      fromContract: previous,
      frameworkComponents: [],
      spaceId: "app",
    });
    if (planResult.kind !== "success") {
      throw new Error(`Planner failed for version ${index}: ${JSON.stringify(planResult.conflicts)}`);
    }

    const ops = planResult.plan.operations as unknown as MigrationPackage["ops"];
    const baseMetadata = {
      from: previous === null ? null : getStorageHash(previous),
      to: getStorageHash(current),
      providedInvariants: [] as string[],
      createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    };
    migrations.push({
      dirName: `${String(index).padStart(4, "0")}_v${index + 1}`,
      metadata: {
        ...baseMetadata,
        migrationHash: computeMigrationHash(baseMetadata, ops),
      },
      ops,
    });

    previous = current;
    index += 1;
  }

  return {
    contractJson: versions[versions.length - 1] as TContract,
    migrations,
    headRef: {
      hash: getStorageHash(versions[versions.length - 1]),
      invariants: [],
    },
  };
}

/**
 * Build a `ContractSpace` for an extension space (e.g. the sync extension),
 * mirroring `buildContractSpaceFixture` but planning with a non-`'app'`
 * `spaceId` and stripping the `_prisma_next_marker` createObjectStore op the
 * planner unconditionally prepends on `fromContract: null` — the marker
 * store belongs to the app space's own baseline; an extension space must
 * never try to recreate it. This is the same op-filtering
 * `generateBaseline`'s `spaceId` option performs for real extension packages
 * (`prisma-idb generate-baseline --space <id>`, see `family-idb/src/core/generate-baseline.ts`).
 */
export function buildExtensionContractSpaceFixture<TContract extends Contract>(
  spaceId: string,
  versions: readonly TContract[]
): ContractSpace<TContract> {
  if (versions.length === 0) {
    throw new Error("buildExtensionContractSpaceFixture requires at least one contract version");
  }

  const planner = new IdbMigrationPlanner();
  const migrations: MigrationPackage[] = [];

  let previous: TContract | null = null;
  let index = 0;
  for (const current of versions) {
    const planResult = planner.plan({
      contract: current,
      schema: null,
      policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
      fromContract: previous,
      frameworkComponents: [],
      spaceId,
    });
    if (planResult.kind !== "success") {
      throw new Error(`Planner failed for version ${index}: ${JSON.stringify(planResult.conflicts)}`);
    }

    const allOps = planResult.plan.operations as unknown as Array<{ kind: string; storeName?: string }>;
    const ops = allOps.filter(
      (op) => !(op.kind === "createObjectStore" && op.storeName === "_prisma_next_marker")
    ) as unknown as MigrationPackage["ops"];
    const baseMetadata = {
      from: previous === null ? null : getStorageHash(previous),
      to: getStorageHash(current),
      providedInvariants: [] as string[],
      createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    };
    migrations.push({
      dirName: `${String(index).padStart(4, "0")}_v${index + 1}`,
      metadata: {
        ...baseMetadata,
        migrationHash: computeMigrationHash(baseMetadata, ops),
      },
      ops,
    });

    previous = current;
    index += 1;
  }

  return {
    contractJson: versions[versions.length - 1] as TContract,
    migrations,
    headRef: {
      hash: getStorageHash(versions[versions.length - 1]),
      invariants: [],
    },
  };
}
