import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbSyncExtension } from "../src/exports/control";
import { getNextBatch } from "../src/core/outbox-store";
import previousSyncContract from "../migrations/snapshots/609932199fd5710d371fa966650a1806c1f587c912ff9d8c40f7b2efd84eed70/contract.json";
import { createAutoMigratingSyncIdbClient, createSyncIdbClient } from "../src/exports/client";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

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

/** The sync extension as it was before the outbox order store existed. */
function previousSyncExtension() {
  const syncSpace = idbSyncExtension.contractSpace;
  const baseline = syncSpace.migrations.find((pkg) => pkg.metadata.from === null)!;
  return {
    ...idbSyncExtension,
    contractSpace: {
      ...syncSpace,
      contractJson: previousSyncContract as unknown as typeof syncSpace.contractJson,
      migrations: [baseline],
      headRef: { hash: baseline.metadata.to, invariants: [] },
    },
  };
}

describe("createAutoMigratingSyncIdbClient", () => {
  it("shares upstream enum accessors with the raw client after migration", async () => {
    const withEnums = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      enums: { Role: ["USER", "ADMIN"] },
      models: { User: { store: "users", key: "id", fields: { id: "String", role: "Role" } } },
    });
    const db = await createAutoMigratingSyncIdbClient({
      contractSpace: buildContractSpaceFixture(withEnums),
      dbName: dbName(),
      extensions: [idbSyncExtension],
    });
    try {
      expect(db.enums).toBe(db.rawClient.enums);
      const Role = db.enums["__unbound__"]!["Role"]!;
      expect(Role.values).toEqual(["USER", "ADMIN"]);
      expect(Role.has("ADMIN")).toBe(true);
      expect(Role.has("OWNER")).toBe(false);
      const orm = db.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
      expect(await orm.users.create({ id: "u1", role: Role.members["ADMIN"] })).toMatchObject({ role: "ADMIN" });
    } finally {
      await db.close();
    }
  });

  it("creates the existing sync stores and indexes plus the cursor meta store from a fresh baseline", async () => {
    const name = dbName();
    const client = await createAutoMigratingSyncIdbClient({
      contractSpace: buildContractSpaceFixture(contract),
      dbName: name,
      extensions: [idbSyncExtension],
    });
    await client.verifyMarker();
    await client.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      expect([...db.objectStoreNames]).toEqual([
        "_idb_sync_meta",
        "_idb_sync_outbox",
        "_idb_sync_outbox_order",
        "_idb_sync_version_meta",
        "_prisma_next_marker",
        "users",
      ]);
      const stores = ["_idb_sync_meta", "_idb_sync_outbox", "_idb_sync_outbox_order", "_idb_sync_version_meta"];
      const tx = db.transaction(stores);
      expect(
        stores.map((name) => {
          const store = tx.objectStore(name);
          return {
            name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: [...store.indexNames].map((name) => {
              const index = store.index(name);
              return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
            }),
          };
        })
      ).toEqual([
        { name: "_idb_sync_meta", keyPath: "id", autoIncrement: false, indexes: [] },
        {
          name: "_idb_sync_outbox",
          keyPath: "id",
          autoIncrement: false,
          indexes: [{ name: "byCreatedAt", keyPath: "createdAt", unique: false, multiEntry: false }],
        },
        {
          name: "_idb_sync_outbox_order",
          keyPath: "seq",
          autoIncrement: true,
          indexes: [{ name: "byEventId", keyPath: "eventId", unique: true, multiEntry: false }],
        },
        { name: "_idb_sync_version_meta", keyPath: "id", autoIncrement: false, indexes: [] },
      ]);
    } finally {
      db.close();
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

  it("upgrades a database at the previous sync head and pushes its queued events first", async () => {
    const name = dbName();
    const syncSpace = idbSyncExtension.contractSpace;
    const orderMigration = syncSpace.migrations.find((pkg) => pkg.dirName === "20261122T1425_outbox_order")!;
    const previous = previousSyncExtension();
    expect(orderMigration.metadata.from).toBe(previous.contractSpace.headRef.hash);
    const old = await createAutoMigratingSyncIdbClient({
      contractSpace: buildContractSpaceFixture(contract),
      dbName: name,
      extensions: [previous],
    });
    await old.close();

    const legacy = (id: string, createdAt: string) => ({
      id,
      entityType: "User",
      operation: "create",
      payload: { id: `u-${id}`, name: id },
      createdAt: new Date(createdAt),
      synced: false,
      syncedAt: null,
      lastAttemptedAt: null,
      tries: 0,
      lastError: null,
      migrationError: null,
      retryable: true,
      versionMetaId: null,
    });
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      expect(raw.objectStoreNames.contains("_idb_sync_outbox_order")).toBe(false);
      await new Promise<void>((resolve, reject) => {
        const tx = raw.transaction("_idb_sync_outbox", "readwrite");
        // Ids sort the other way round from createdAt, so the order cannot come from the ids.
        tx.objectStore("_idb_sync_outbox").put(legacy("b-legacy-first", "2026-01-01T00:00:00Z"));
        tx.objectStore("_idb_sync_outbox").put(legacy("a-legacy-second", "2026-01-02T00:00:00Z"));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      raw.close();
    }

    const client = await createAutoMigratingSyncIdbClient({
      contractSpace: buildContractSpaceFixture(contract),
      dbName: name,
      extensions: [idbSyncExtension],
    });
    try {
      const orm = client.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
      await orm.users.create({ id: "u-new-1", name: "new 1" });
      await orm.users.create({ id: "u-new-2", name: "new 2" });

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        expect(db.objectStoreNames.contains("_idb_sync_outbox_order")).toBe(true);
        const order = db.transaction("_idb_sync_outbox_order").objectStore("_idb_sync_outbox_order");
        expect(order.autoIncrement).toBe(true);
        expect([...order.indexNames].length).toBeGreaterThan(0);
        const marker = await new Promise<{ storageHash: string }>((resolve, reject) => {
          const request = db.transaction("_prisma_next_marker").objectStore("_prisma_next_marker").get("idb-sync");
          request.onsuccess = () => resolve(request.result as { storageHash: string });
          request.onerror = () => reject(request.error);
        });
        expect(marker.storageHash).toBe(syncSpace.headRef.hash);
      } finally {
        db.close();
      }

      const batch = await getNextBatch(client.rawClient);
      expect(batch.map((event) => (event.payload as { id: string }).id)).toEqual([
        "u-b-legacy-first",
        "u-a-legacy-second",
        "u-new-1",
        "u-new-2",
      ]);
    } finally {
      await client.close();
    }
  });

  it("names the missing order store when an app skipped the sync extension's migration", async () => {
    const name = dbName();
    const contractSpace = buildContractSpaceFixture(contract);
    const old = await createAutoMigratingSyncIdbClient({
      contractSpace,
      dbName: name,
      extensions: [previousSyncExtension()],
    });
    await old.close();
    const client = createSyncIdbClient({ contract: contractSpace.contractJson, dbName: name });
    try {
      const orm = client.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
      const missing = /no "_idb_sync_outbox_order" store[\s\S]*createAutoMigratingSyncIdbClient/;
      await expect(orm.users.create({ id: "u1", name: "A" })).rejects.toThrow(missing);
      await expect(client.outbox.hasPending()).rejects.toThrow(missing);
    } finally {
      await client.close();
    }
  });
});
