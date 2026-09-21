/**
 * Test helper: build an in-memory `ContractSpace` from a single contract
 * (a one-package baseline — enough to exercise `createAutoMigratingSyncIdbClient`,
 * which just needs *a* real migration graph, not an evolving one).
 *
 * Mirrors client-idb/test/_contract-space-fixture.ts's `buildContractSpaceFixture`.
 */

import type { Contract } from "@prisma/orm-framework/contract/types";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";

function getStorageHash(contract: unknown): string {
  return (contract as { storage: { storageHash: string } }).storage.storageHash;
}

export function buildContractSpaceFixture<TContract extends Contract>(contract: TContract): ContractSpace<TContract> {
  const planner = new IdbMigrationPlanner();
  const planResult = planner.plan({
    contract,
    schema: null,
    policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
    fromContract: null,
    frameworkComponents: [],
    spaceId: "app",
  });
  if (planResult.kind !== "success") {
    throw new Error(`Planner failed: ${JSON.stringify(planResult.conflicts)}`);
  }

  const ops = planResult.plan.operations as unknown as MigrationPackage["ops"];
  const baseMetadata = {
    from: null,
    to: getStorageHash(contract),
    providedInvariants: [] as string[],
    createdAt: new Date(2026, 0, 1).toISOString(),
  };
  const migrations: MigrationPackage[] = [
    {
      dirName: "0000_baseline",
      metadata: { ...baseMetadata, migrationHash: computeMigrationHash(baseMetadata, ops) },
      ops,
    },
  ];

  return {
    contractJson: contract,
    migrations,
    headRef: { hash: getStorageHash(contract), invariants: [] },
  };
}
