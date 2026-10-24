import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbSyncExtension } from "../src/exports/control";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
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
        "_idb_sync_version_meta",
        "_prisma_next_marker",
        "users",
      ]);
      const stores = ["_idb_sync_meta", "_idb_sync_outbox", "_idb_sync_version_meta"];
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
});
