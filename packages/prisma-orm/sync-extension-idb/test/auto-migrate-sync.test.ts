import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbSyncExtension } from "../src/exports/control";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import { contractSpaceFromJson } from "@prisma/orm-toolchain/migration-tools/spaces";
import legacyContract from "../migrations/snapshots/c2c485fabf1d79f78fdaf74a1c4dd94fe4e3981493233534e003c613f643945d/contract.json" with { type: "json" };

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", name: "String" } },
  },
});

let dbCounter = 0;
function dbName(): string {
  return `auto-mig-sync-${++dbCounter}`;
}

describe("createAutoMigratingSyncIdbClient", () => {
  it("rehashes the legacy sync space without changing queued outbox records", async () => {
    const space = buildContractSpaceFixture(contract);
    const name = dbName();
    const baseline = idbSyncExtension.contractSpace.migrations[0]!;
    const legacyExtension = {
      ...idbSyncExtension,
      contractSpace: contractSpaceFromJson({
        contractJson: legacyContract,
        migrations: [baseline],
        headRef: { hash: baseline.metadata.to, invariants: [] },
      }),
    };
    const old = await createAutoMigratingSyncIdbClient({
      contractSpace: space,
      dbName: name,
      extensions: [legacyExtension],
    });
    const orm = old.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
    await orm.users.create({ id: "u1", name: "Alice" });
    const readOutbox = (db: typeof old) =>
      db.withTransaction(["_idb_sync_outbox"], async (scope) =>
        scope.execute({ kind: "cursor-scan", storeName: "_idb_sync_outbox" } as never)
      );
    const before = await readOutbox(old);
    await old.close();

    const rehash = idbSyncExtension.contractSpace.migrations[1]!;
    expect(rehash.metadata.from).toBe(baseline.metadata.to);
    expect(rehash.ops).toEqual([]);
    const current = await createAutoMigratingSyncIdbClient({
      contractSpace: space,
      dbName: name,
      extensions: [idbSyncExtension],
    });
    try {
      expect(await readOutbox(current)).toEqual(before);
    } finally {
      await current.close();
    }
  });

  beforeEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });
  afterEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });

  it("migrates then returns a sync-tracked client in one call — writes go through the outbox", async () => {
    const space = buildContractSpaceFixture(contract);
    const name = dbName();

    const db = await createAutoMigratingSyncIdbClient({
      contractSpace: space,
      dbName: name,
      extensions: [idbSyncExtension],
    });
    try {
      const orm = db.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
      await orm.users.create({ id: "u1", name: "Alice" });

      const outbox = await db.withTransaction(["_idb_sync_outbox"], async (scope) => {
        return scope.execute({ kind: "cursor-scan", storeName: "_idb_sync_outbox" } as never) as Promise<
          Record<string, unknown>[]
        >;
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ entityType: "User", operation: "create" });
    } finally {
      await db.close();
    }
  });

  it("verifyMarker()/close() work directly on the returned client, no .rawClient hop needed", async () => {
    const space = buildContractSpaceFixture(contract);
    const db = await createAutoMigratingSyncIdbClient({
      contractSpace: space,
      dbName: dbName(),
      extensions: [idbSyncExtension],
    });

    expect(await db.verifyMarker()).toBe(true);
    await db.close();
  });

  it("a second call against the same DB name doesn't re-run migrations (already at head)", async () => {
    const space = buildContractSpaceFixture(contract);
    const name = dbName();

    const db1 = await createAutoMigratingSyncIdbClient({
      contractSpace: space,
      dbName: name,
      extensions: [idbSyncExtension],
    });
    const orm1 = db1.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
    await orm1.users.create({ id: "u1", name: "Alice" });
    await db1.close();

    const db2 = await createAutoMigratingSyncIdbClient({
      contractSpace: space,
      dbName: name,
      extensions: [idbSyncExtension],
    });
    try {
      const orm2 = db2.orm as unknown as { users: { all(): { toArray(): Promise<unknown[]> } } };
      const users = await orm2.users.all().toArray();
      expect(users).toHaveLength(1); // existing data preserved, not wiped by a re-migration
    } finally {
      await db2.close();
    }
  });
});
