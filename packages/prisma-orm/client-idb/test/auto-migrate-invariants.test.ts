/** Auto-migration picks the path whose migrations provide the invariants the head requires. */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const v1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { User: { store: "users", key: "id", fields: { id: "String" } } },
});
const v2 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String" } },
    Post: { store: "posts", key: "id", fields: { id: "String" } },
  },
});

const chain = buildContractSpaceFixture([v1, v2]);
const [baseline, plain] = chain.migrations as [MigrationPackage, MigrationPackage];

/** `pkg` with other metadata, rehashed so it passes the integrity check. */
function variant(
  pkg: MigrationPackage,
  dirName: string,
  metadata: Partial<MigrationPackage["metadata"]>
): MigrationPackage {
  const next = { ...pkg.metadata, ...metadata };
  const { migrationHash: _old, ...hashed } = next;
  return { dirName, ops: pkg.ops, metadata: { ...next, migrationHash: computeMigrationHash(hashed, pkg.ops) } };
}

/** The same step as `plain`, recorded as providing `seeded`. */
const seeding = variant(plain, "0001_v2_seeded", {
  providedInvariants: ["seeded"],
  createdAt: new Date(2026, 0, 2).toISOString(),
});

function space(migrations: MigrationPackage[], invariants: string[]): ContractSpace<typeof v2> {
  return { ...chain, migrations, headRef: { hash: v2.storage.storageHash, invariants } };
}

/** Reads the app space's marker record straight from IndexedDB. */
function readMarker(dbName: string): Promise<{ storageHash: string; invariants: string[] } | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("_prisma_next_marker").objectStore("_prisma_next_marker").get("app");
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        db.close();
        resolve(get.result as { storageHash: string; invariants: string[] } | undefined);
      };
    };
  });
}

let dbCounter = 0;
describe("auto-migrate invariants", () => {
  it("takes the migration that provides a required invariant, whatever order the bundle lists them in", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    const client = await createAutoMigratingIdbClient({
      contractSpace: space([baseline, seeding, plain], ["seeded"]),
      dbName,
    });
    await client.close();
    expect(await readMarker(dbName)).toMatchObject({ storageHash: v2.storage.storageHash, invariants: ["seeded"] });
  });

  it("refuses a head whose required invariant no migration provides, without applying anything", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    await expect(
      createAutoMigratingIdbClient({ contractSpace: space([baseline, plain], ["seeded"]), dbName })
    ).rejects.toThrow(/provide the required invariant\(s\) seeded/);
    const client = await createAutoMigratingIdbClient({ contractSpace: space([baseline, plain], []), dbName });
    try {
      expect(await client.verifyMarker()).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("runs a migration for a newly required invariant on a database already at the head", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    const first = await createAutoMigratingIdbClient({ contractSpace: space([baseline, plain], []), dbName });
    await first.close();
    expect(await readMarker(dbName)).toMatchObject({ invariants: [] });

    // A data fix from the head to itself that records `fixed`.
    const fix = variant({ ...plain, ops: [] }, "0002_fix", {
      from: v2.storage.storageHash,
      providedInvariants: ["fixed"],
      createdAt: new Date(2026, 0, 3).toISOString(),
    });
    const second = await createAutoMigratingIdbClient({
      contractSpace: space([baseline, plain, fix], ["fixed"]),
      dbName,
    });
    await second.close();
    expect(await readMarker(dbName)).toMatchObject({ storageHash: v2.storage.storageHash, invariants: ["fixed"] });
  });
});
