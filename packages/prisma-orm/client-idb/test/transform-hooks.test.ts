import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import type { ContractSpace } from "@prisma/orm-framework/components/control";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { transformRecordsOp } from "@prisma-idb/target-idb/migration";
import { createAutoMigratingIdbClient, createManagedAutoIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture, buildExtensionContractSpaceFixture } from "./_contract-space-fixture";

const app = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", name: "String" } },
  },
});
const metadataContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Metadata: { store: "metadata", key: "id", fields: { id: "String", name: "String" } },
  },
});
const observerContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Observed: { store: "observed", key: "id", fields: { id: "String", name: "String" } },
  },
});

function withTransforms<T extends typeof app>(space: ContractSpace<T>, stores: string[]): ContractSpace<T> {
  const migration = space.migrations[0]!;
  const ops = [
    ...migration.ops,
    ...stores.map((store) => transformRecordsOp(store, { renameFields: { label: "name" } })),
  ];
  return {
    ...space,
    migrations: [
      {
        ...migration,
        ops,
        metadata: { ...migration.metadata, migrationHash: computeMigrationHash(migration.metadata, ops) },
      },
    ],
  };
}
const appSpace = withTransforms(buildContractSpaceFixture([app]), ["users"]);
// Each extension also transforms its own store: those ops must not reach any hook.
const metadataSpace = withTransforms(buildExtensionContractSpaceFixture("metadata", [metadataContract]), ["metadata"]);
const observerSpace = withTransforms(buildExtensionContractSpaceFixture("observer", [observerContract]), ["observed"]);

describe("auto-migration extension transform hooks", () => {
  it.each([false, true])("maps app stores and runs hooks in sequence (managed: %s)", async (managed) => {
    const seen: string[] = [];
    const hooks: IdbExtensionSpace[] = [
      {
        spaceId: "metadata",
        contractSpace: metadataSpace,
        onTransformRecords: (tx, op, model, done) => {
          seen.push(`first:${model}:${op.storeName}`);
          const request = tx.objectStore("metadata").put({ id: "hook", name: model });
          request.onsuccess = () => {
            done();
            done();
          };
        },
      },
      {
        spaceId: "observer",
        contractSpace: observerSpace,
        onTransformRecords: (tx, op, model, done) => {
          const request = tx.objectStore("metadata").get("hook");
          request.onsuccess = () => {
            seen.push(`second:${model}:${op.storeName}:${request.result.name}`);
            done();
          };
        },
      },
    ];
    const options = { contractSpace: appSpace, extensions: hooks, dbName: "hooks", factory: new IDBFactory() };
    const manager = managed ? createManagedAutoIdbClient(options) : undefined;
    const client = manager ? await manager.get() : await createAutoMigratingIdbClient(options);
    try {
      expect(seen).toEqual(["first:User:users", "second:User:users:User"]);
      expect(await client.verifyMarker()).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("aborts when a later hook throws from an IDB event continuation", async () => {
    const extensions: IdbExtensionSpace[] = [
      {
        spaceId: "metadata",
        contractSpace: metadataSpace,
        onTransformRecords: (tx, _op, _model, done) => {
          const request = tx.objectStore("metadata").put({ id: "hook", name: "first" });
          request.onsuccess = () => done();
        },
      },
      {
        spaceId: "observer",
        contractSpace: observerSpace,
        onTransformRecords: () => {
          throw new Error("hook failed");
        },
      },
    ];
    await expect(
      createAutoMigratingIdbClient({ contractSpace: appSpace, extensions, dbName: "hooks", factory: new IDBFactory() })
    ).rejects.toThrow("hook failed");
  });
});
