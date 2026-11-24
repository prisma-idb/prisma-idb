/** Auto-migration picks the path whose migrations provide the invariants the head requires. */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture, buildExtensionContractSpaceFixture } from "./_contract-space-fixture";

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

/** Reads a space's marker record straight from IndexedDB. */
function readMarker(
  dbName: string,
  spaceId = "app"
): Promise<{ storageHash: string; invariants: string[] } | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("_prisma_next_marker").objectStore("_prisma_next_marker").get(spaceId);
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

  it("applies the package of the edge it selected, even when another package has the same stored hash", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    // A copy of `seeding` whose stored hash was replaced with `plain`'s. The route takes it for
    // `seeded`; applying `plain`, which a lookup by hash finds, would skip the integrity check.
    const forged = { ...seeding, metadata: { ...seeding.metadata, migrationHash: plain.metadata.migrationHash } };
    await expect(
      createAutoMigratingIdbClient({ contractSpace: space([baseline, forged, plain], ["seeded"]), dbName })
    ).rejects.toThrow(/Migration package "0001_v2_seeded" failed integrity check/);
  });

  it("refuses a bundle with two packages of the same name", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    await expect(
      createAutoMigratingIdbClient({
        contractSpace: space([baseline, plain, { ...seeding, dirName: plain.dirName }], []),
        dbName,
      })
    ).rejects.toThrow(new RegExp(`two migration packages named "${plain.dirName}"`));
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

  it("says so when a database at the head lacks a required invariant that no migration provides", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    const first = await createAutoMigratingIdbClient({ contractSpace: space([baseline, plain], []), dbName });
    await first.close();
    await expect(
      createAutoMigratingIdbClient({ contractSpace: space([baseline, plain], ["fixed"]), dbName })
    ).rejects.toThrow(/is at its head .* does not record the required invariant\(s\) fixed/);
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

  it("keeps the invariants a marker already records when a later path provides new ones", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    const first = await createAutoMigratingIdbClient({ contractSpace: space([baseline, seeding], ["seeded"]), dbName });
    await first.close();
    expect(await readMarker(dbName)).toMatchObject({ invariants: ["seeded"] });

    // The new head requires only `fixed`; `seeded` must survive on the marker.
    const fix = variant({ ...plain, ops: [] }, "0002_fix", {
      from: v2.storage.storageHash,
      providedInvariants: ["fixed"],
      createdAt: new Date(2026, 0, 3).toISOString(),
    });
    const second = await createAutoMigratingIdbClient({
      contractSpace: space([baseline, seeding, fix], ["fixed"]),
      dbName,
    });
    await second.close();
    expect(await readMarker(dbName)).toMatchObject({
      storageHash: v2.storage.storageHash,
      invariants: ["fixed", "seeded"],
    });
  });

  it("records each space's own invariants when an extension space migrates with the app space", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    const extV1 = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { Widget: { store: "_ext_widgets", key: "id", fields: { id: "String" } } },
    });
    const extChain = buildExtensionContractSpaceFixture("ext", [extV1]);
    const [extBaseline] = extChain.migrations as [MigrationPackage];
    const extProviding = variant(extBaseline, "0000_v1_ext", { providedInvariants: ["ext-fixed"] });
    const extension = {
      spaceId: "ext",
      contractSpace: {
        ...extChain,
        migrations: [extProviding],
        headRef: { ...extChain.headRef, invariants: ["ext-fixed"] },
      },
    };

    const client = await createAutoMigratingIdbClient({
      contractSpace: space([baseline, seeding, plain], ["seeded"]),
      dbName,
      extensions: [extension],
    });
    await client.close();
    expect(await readMarker(dbName, "app")).toMatchObject({ invariants: ["seeded"] });
    expect(await readMarker(dbName, "ext")).toMatchObject({ invariants: ["ext-fixed"] });

    // An extension that lacks its invariant is refused, naming its space, before anything is applied.
    const other = `auto-migrate-invariants-${++dbCounter}`;
    await expect(
      createAutoMigratingIdbClient({
        contractSpace: space([baseline, plain], []),
        dbName: other,
        extensions: [{ ...extension, contractSpace: { ...extension.contractSpace, migrations: [extBaseline] } }],
      })
    ).rejects.toThrow(/space "ext".*ext-fixed/);
  });

  it("keeps retrying after a lost race when a space is at its head hash but lacks a required invariant", async () => {
    const dbName = `auto-migrate-invariants-${++dbCounter}`;
    const fix = variant({ ...plain, ops: [] }, "0002_fix", {
      from: v2.storage.storageHash,
      providedInvariants: ["fixed"],
      createdAt: new Date(2026, 0, 3).toISOString(),
    });
    // Both opens read an empty database and plan version 1. The first one's upgrade wins and leaves the
    // marker at the head without `fixed`, so the second must plan again from that marker.
    const [plainClient, fixedClient] = await Promise.all([
      createAutoMigratingIdbClient({ contractSpace: space([baseline, plain], []), dbName }),
      createAutoMigratingIdbClient({ contractSpace: space([baseline, plain, fix], ["fixed"]), dbName }),
    ]);
    await Promise.all([plainClient.close(), fixedClient.close()]);
    expect(await readMarker(dbName)).toMatchObject({ storageHash: v2.storage.storageHash, invariants: ["fixed"] });
  });
});
