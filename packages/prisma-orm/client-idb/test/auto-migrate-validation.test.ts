/** Failed migration chains leave pending schema unapplied and allow a corrected bundle to open. */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { User: { store: "users", key: "id", fields: { id: "String" } } },
});

const valid = buildContractSpaceFixture([contract]);
const baseline = valid.migrations[0]!;
const loopMetadata = { ...baseline.metadata, to: "loop" };
const loop: MigrationPackage = {
  ...baseline,
  metadata: { ...loopMetadata, migrationHash: computeMigrationHash(loopMetadata, baseline.ops) },
};
const repeatedMetadata = { ...loopMetadata, from: "loop" };
const repeated: MigrationPackage = {
  dirName: "loop",
  metadata: { ...repeatedMetadata, migrationHash: computeMigrationHash(repeatedMetadata, []) },
  ops: [],
};
const nonIdbOps = [{ kind: "sql", statement: "SELECT 1" }] as unknown as MigrationPackage["ops"];
const nonIdb: MigrationPackage = {
  ...baseline,
  ops: nonIdbOps,
  metadata: { ...baseline.metadata, migrationHash: computeMigrationHash(baseline.metadata, nonIdbOps) },
};

let dbCounter = 0;
describe("auto-migrate chain validation", () => {
  it.each([
    {
      name: "tampered hash",
      migrations: [{ ...baseline, metadata: { ...baseline.metadata, migrationHash: "wrong" } }],
      error: /failed integrity check/,
    },
    { name: "cycle", migrations: [loop, repeated], error: /contains a cycle/ },
    { name: "non-IDB operation", migrations: [nonIdb], error: /Non-IDB operation/ },
  ])("rejects $name without applying pending schema", async ({ migrations, error }) => {
    const dbName = `auto-migrate-validation-${++dbCounter}`;
    await expect(
      createAutoMigratingIdbClient({
        contractSpace: { ...valid, migrations },
        dbName,
      })
    ).rejects.toThrow(error);

    // A partial apply would make the corrected baseline try to recreate its stores.
    const client = await createAutoMigratingIdbClient({ contractSpace: valid, dbName });
    try {
      expect(await client.verifyMarker()).toBe(true);
      await client.orm["users"]!.create({ id: "u1" });
      expect(await client.orm["users"]!.all().toArray()).toEqual([{ id: "u1" }]);
    } finally {
      await client.close();
    }
  });
});
