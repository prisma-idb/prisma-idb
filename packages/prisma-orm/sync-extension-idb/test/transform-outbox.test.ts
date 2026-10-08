import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { ContractSpace, MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { coerce, createIndexOp, defaultIfMissing, transformRecordsOp } from "@prisma-idb/target-idb/migration";
import type { IdbDdlOp } from "@prisma-idb/target-idb/runtime";
import { idbSyncExtension } from "../src/exports/control";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import { asAccessors, scanAll } from "./helpers";

const v1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String", enabled: "Boolean", obsolete: "String" },
    },
  },
});
const v2 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", label: "String", count: "Int", role: "String" },
      indexes: { byLabel: { keyPath: "label" } },
    },
  },
});
const transform = transformRecordsOp("users", {
  renameFields: { label: "name", count: "enabled" },
  fields: { count: coerce("int"), role: defaultIfMissing("member") },
  removeFields: ["obsolete"],
});

function evolvedSpace(
  ops: readonly IdbDdlOp[] = [transform, createIndexOp("users", "byLabel", { keyPath: "label", unique: false })]
): ContractSpace<typeof v2> {
  const metadata = {
    from: v1.storage.storageHash,
    to: v2.storage.storageHash,
    providedInvariants: [],
    createdAt: "2026-10-08T00:00:00.000Z",
  };
  const migrationOps = ops as unknown as MigrationPackage["ops"];
  return {
    contractJson: v2,
    headRef: { hash: v2.storage.storageHash, invariants: [] },
    migrations: [
      ...buildContractSpaceFixture(v1).migrations,
      {
        dirName: "0001_transform",
        metadata: { ...metadata, migrationHash: computeMigrationHash(metadata, migrationOps) },
        ops: migrationOps,
      },
    ],
  };
}

function options(factory: IDBFactory) {
  return { factory, dbName: "outbox-migration", extensions: [idbSyncExtension] };
}

async function seed(factory: IDBFactory) {
  const client = await createAutoMigratingSyncIdbClient({
    ...options(factory),
    contractSpace: buildContractSpaceFixture(v1),
  });
  const users = asAccessors(client.orm)["users"]!;
  const rawUsers = asAccessors(client.rawClient.orm)["users"]!;
  await rawUsers.create({ id: "update", name: "Before", enabled: true, obsolete: "old" });
  await rawUsers.create({ id: "delete", name: "Delete", enabled: true, obsolete: "old" });
  await users.create({ id: "create", name: "Create", enabled: true, obsolete: "old" });
  await users.where({ id: "update" }).update({ name: "Edited", enabled: false, obsolete: "old" });
  await users.delete("delete");
  const events = await scanAll(client, "_idb_sync_outbox");
  await client.close();
  return events;
}

describe("pending outbox migrations", () => {
  it("rewrites creates fully and only present update fields, while preserving deletes", async () => {
    const factory = new IDBFactory();
    const before = await seed(factory);
    const client = await createAutoMigratingSyncIdbClient({ ...options(factory), contractSpace: evolvedSpace() });
    try {
      const events = await scanAll(client, "_idb_sync_outbox");
      expect(events.find((event) => event["operation"] === "create")?.["payload"]).toEqual({
        id: "create",
        label: "Create",
        count: 1,
        role: "member",
      });
      expect(events.find((event) => event["operation"] === "update")?.["payload"]).toEqual({
        key: "update",
        patch: { label: "Edited", count: 0 },
      });
      expect(events.find((event) => event["operation"] === "delete")).toStrictEqual(
        before.find((event) => event["operation"] === "delete")
      );
      expect(await asAccessors(client.orm)["users"]!.findUnique("update")).toEqual({
        id: "update",
        label: "Edited",
        count: 0,
        role: "member",
      });
    } finally {
      await client.close();
    }
  });

  it("leaves synced and other-model events unchanged, and keeps empty updates queued", async () => {
    const factory = new IDBFactory();
    const before = await seed(factory);
    const client = await createAutoMigratingSyncIdbClient({
      ...options(factory),
      contractSpace: buildContractSpaceFixture(v1),
    });
    const create = before.find((event) => event["operation"] === "create")!;
    const unchanged = [
      { ...create, id: "synced", synced: true },
      { ...create, id: "other-model", entityType: "Post" },
    ];
    const emptyUpdate = {
      ...create,
      id: "empty",
      operation: "update",
      payload: { key: "update", patch: { obsolete: "old" } },
    };
    const sparseUpdate = {
      ...create,
      id: "sparse",
      operation: "update",
      payload: { key: "update", patch: { name: "Only label" } },
    };
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      for (const record of [...unchanged, emptyUpdate, sparseUpdate]) {
        await scope.execute({ kind: "put", storeName: "_idb_sync_outbox", record } as never);
      }
    });
    await client.close();
    const migrated = await createAutoMigratingSyncIdbClient({ ...options(factory), contractSpace: evolvedSpace() });
    try {
      const events = await scanAll(migrated, "_idb_sync_outbox");
      for (const event of unchanged) expect(events.find((row) => row["id"] === event.id)).toStrictEqual(event);
      expect(events.find((row) => row["id"] === "empty")).toStrictEqual({
        ...emptyUpdate,
        payload: { key: "update", patch: {} },
      });
      expect(events.find((row) => row["id"] === "sparse")).toStrictEqual({
        ...sparseUpdate,
        payload: { key: "update", patch: { label: "Only label" } },
      });
    } finally {
      await migrated.close();
    }
  });

  it("rewrites rejected events like pending ones and keeps one it cannot convert", async () => {
    const factory = new IDBFactory();
    const before = await seed(factory);
    const client = await createAutoMigratingSyncIdbClient({
      ...options(factory),
      contractSpace: buildContractSpaceFixture(v1),
    });
    const create = before.find((event) => event["operation"] === "create")!;
    const rejected = { ...create, id: "rejected", retryable: false, tries: 3, lastError: "unique violation" };
    const invalid = { ...rejected, id: "invalid", payload: { id: "bad", enabled: "invalid" } };
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      for (const record of [rejected, invalid]) {
        await scope.execute({ kind: "put", storeName: "_idb_sync_outbox", record } as never);
      }
    });
    await client.close();
    const migrated = await createAutoMigratingSyncIdbClient({ ...options(factory), contractSpace: evolvedSpace() });
    try {
      const events = await scanAll(migrated, "_idb_sync_outbox");
      expect(events.find((row) => row["id"] === "rejected")).toStrictEqual({
        ...rejected,
        payload: { id: "create", label: "Create", count: 1, role: "member" },
      });
      expect(events.find((row) => row["id"] === "invalid")).toStrictEqual(invalid);
    } finally {
      await migrated.close();
    }
  });

  it("rolls back app records, rewritten outbox events, markers and the database version on a bad queued value", async () => {
    const factory = new IDBFactory();
    const events = await seed(factory);
    const client = await createAutoMigratingSyncIdbClient({
      ...options(factory),
      contractSpace: buildContractSpaceFixture(v1),
    });
    await client.withTransaction(["_idb_sync_outbox"], (scope) =>
      scope.execute({
        kind: "put",
        storeName: "_idb_sync_outbox",
        record: {
          ...events.find((event) => event["operation"] === "create"),
          id: "zz-invalid",
          payload: { id: "bad", enabled: "invalid" },
        },
      } as never)
    );
    await client.close();
    const before = await snapshot(factory);
    await expect(
      createAutoMigratingSyncIdbClient({ ...options(factory), contractSpace: evolvedSpace() })
    ).rejects.toThrow("cannot coerce invalid to int");
    expect(await snapshot(factory)).toStrictEqual(before);
  });
});

async function snapshot(factory: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("outbox-migration");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const stores = Array.from(db.objectStoreNames);
    const tx = db.transaction(stores);
    const records = await Promise.all(
      stores.map(
        (store) =>
          new Promise<unknown[]>((resolve, reject) => {
            const request = tx.objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          })
      )
    );
    return { version: db.version, stores, records };
  } finally {
    db.close();
  }
}
