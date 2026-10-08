import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { IdbMigrationPlanner, transformRecordsOp } from "@prisma-idb/target-idb/migration";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { createAutoMigratingSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import { createSqlSyncAdapter } from "../src/exports/index";
import { ormRootFor } from "../src/core/orm-root";
import { testContract, testSyncServer, testDb, seed } from "./helpers";

const oldContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", legacyName: "String" } },
  },
});
const newContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      indexes: { byName: { keyPath: "name" } },
    },
  },
});

function migration(from: Contract | null, to: Contract): MigrationPackage {
  const plan = new IdbMigrationPlanner().plan({
    contract: to,
    fromContract: from,
    schema: null,
    policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
    frameworkComponents: [],
    spaceId: "app",
  });
  if (plan.kind !== "success") throw new Error("migration plan failed");
  const ops = [
    ...(from ? [transformRecordsOp("users", { renameFields: { name: "legacyName" } })] : []),
    ...plan.plan.operations,
  ] as unknown as MigrationPackage["ops"];
  const metadata = {
    from: from?.storage.storageHash ?? null,
    to: to.storage.storageHash,
    providedInvariants: [],
    createdAt: "2026-10-08T00:00:00.000Z",
  };
  return {
    dirName: from ? "0001_rename" : "0000_baseline",
    metadata: { ...metadata, migrationHash: computeMigrationHash(metadata, ops) },
    ops,
  };
}
const baseline = migration(null, oldContract);
function space<T extends Contract>(contract: T, migrations: MigrationPackage[]): ContractSpace<T> {
  return { contractJson: contract, migrations, headRef: { hash: contract.storage.storageHash, invariants: [] } };
}

/** The client ORM is dynamically typed here: the contract is built inside the test. */
interface UserAccessor {
  create(data: Record<string, unknown>): Promise<unknown>;
  findUnique(key: string): Promise<unknown>;
  where(filter: Record<string, unknown>): { update(data: Record<string, unknown>): Promise<unknown> };
}
const usersOf = (orm: unknown) => (orm as { users: UserAccessor }).users;

describe("migrated outbox push", () => {
  it("preserves an unsent edit when the client and server use the renamed field", async () => {
    const factory = new IDBFactory();
    const dbName = "migrated-outbox";
    const scopeKey = "u1";
    const options = { factory, dbName, extensions: [idbSyncExtension] };
    const old = await createAutoMigratingSyncIdbClient({ ...options, contractSpace: space(oldContract, [baseline]) });
    await old.withoutTracking((orm) => usersOf(orm).create({ id: scopeKey, legacyName: "Before" }));
    await usersOf(old.orm).where({ id: scopeKey }).update({ legacyName: "Unsent edit" });
    await old.close();

    // The SQL fixture represents the server after its matching legacyName → name migration.
    const serverDb = await testDb();
    await seed(serverDb, { User: [{ id: scopeKey, name: "Before" }] });
    const adapter = createSqlSyncAdapter({
      contract: testContract,
      syncServer: testSyncServer,
      // This fixture tests migrated outbox delivery, not contract fingerprint negotiation.
      contractFingerprintCheck: "off",
    });
    const client = await createAutoMigratingSyncIdbClient({
      ...options,
      contractSpace: space(newContract, [baseline, migration(oldContract, newContract)]),
    });
    const results: unknown[] = [];
    const worker = client.createSyncWorker({
      pushHandler: async (events) => {
        // The wire event shape matches the outbox event; only the static types differ.
        const outcome = await adapter.applyPush(serverDb, { scopeKey, events: events as never });
        if (!outcome.ok) throw new Error("push failed");
        results.push(...outcome.results);
        return [...outcome.results];
      },
      pullHandler: async () => [],
    });
    try {
      await worker.forceSync();
      expect(results).toEqual([{ id: expect.any(String), success: true }]);
      expect(await ormRootFor(serverDb, "User").first({ id: scopeKey })).toEqual({ id: scopeKey, name: "Unsent edit" });
      expect(await usersOf(client.orm).findUnique(scopeKey)).toEqual({ id: scopeKey, name: "Unsent edit" });
      expect(
        await client.withTransaction(["_idb_sync_outbox"], (tx) =>
          tx.execute({ kind: "cursor-scan", storeName: "_idb_sync_outbox" } as never)
        )
      ).toMatchObject([{ synced: true }]);
    } finally {
      worker.stop();
      await client.close();
    }
  });
});
