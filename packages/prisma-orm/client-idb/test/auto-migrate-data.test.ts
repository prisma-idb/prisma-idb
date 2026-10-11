import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { MigrationPackage } from "@prisma/orm-framework/components/control";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { dropObjectStoreOp, setLiteral, transformRecordsOp } from "@prisma-idb/target-idb/migration";
import { readMarker, writeMarker } from "@prisma-idb/target-idb/runtime";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture, buildExtensionContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { User: { store: "users", key: "id", fields: { id: "String", name: "String" } } },
});
const baseline = buildContractSpaceFixture([contract]);

function dataMigration(ops: MigrationPackage["ops"]): MigrationPackage {
  const metadata = {
    from: contract.storage.storageHash,
    to: contract.storage.storageHash,
    providedInvariants: [],
    createdAt: "2026-10-11T00:00:00.000Z",
  };
  return { dirName: "0001_data", metadata: { ...metadata, migrationHash: computeMigrationHash(metadata, ops) }, ops };
}
const migration = dataMigration([transformRecordsOp("users", { fields: { name: setLiteral("Migrated") } })]);
const upgraded = { ...baseline, migrations: [...baseline.migrations, migration] };

function options(factory: IDBFactory) {
  return { factory, dbName: "data-migration" };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open("data-migration");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("same-hash data migrations", () => {
  it("runs once on an existing database and preserves later edits on reopen", async () => {
    const factory = new IDBFactory();
    const old = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: baseline });
    await old.orm["users"]!.create({ id: "u1", name: "Before" });
    await old.close();
    const legacyDb = await openDatabase(factory);
    await writeMarker(legacyDb, {
      space: "app",
      storageHash: contract.storage.storageHash,
      meta: { retained: "legacy metadata" },
    });
    legacyDb.close();

    const client = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: upgraded });
    expect(await client.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Migrated" });
    await client.orm["users"]!.where({ id: "u1" }).update({ name: "Edited" });
    await client.close();
    const migratedDb = await openDatabase(factory);
    const migratedVersion = migratedDb.version;
    const marker = await readMarker(migratedDb, "app");
    expect(marker?.storageHash).toBe(contract.storage.storageHash);
    expect(marker?.meta).toEqual({
      retained: "legacy metadata",
      appliedDataMigrations: [migration.metadata.migrationHash],
    });
    migratedDb.close();

    const reopened = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: upgraded });
    expect(await reopened.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Edited" });
    await reopened.close();
    const reopenedDb = await openDatabase(factory);
    expect(reopenedDb.version).toBe(migratedVersion);
    reopenedDb.close();
  });

  it("records a fresh install's no-op transform so later rows are not rewritten", async () => {
    const factory = new IDBFactory();
    const client = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: upgraded });
    await client.orm["users"]!.create({ id: "u1", name: "Created after migration" });
    await client.close();

    const reopened = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: upgraded });
    expect(await reopened.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Created after migration" });
    await reopened.close();
  });

  it("rolls back interrupted transforms and retries the same migration", async () => {
    const factory = new IDBFactory();
    const extensionContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { Audit: { store: "audit", key: "id", fields: { id: "String" } } },
    });
    let interrupted = true;
    const extension: IdbExtensionSpace = {
      spaceId: "audit",
      contractSpace: buildExtensionContractSpaceFixture("audit", [extensionContract]),
      onTransformRecords: (_tx, _op, _model, onDone) => {
        if (interrupted) throw new Error("Interrupted transform");
        onDone();
      },
    };
    const old = await createAutoMigratingIdbClient({
      ...options(factory),
      contractSpace: baseline,
      extensions: [extension],
    });
    await old.orm["users"]!.create({ id: "u1", name: "Before" });
    await old.close();

    await expect(
      createAutoMigratingIdbClient({ ...options(factory), contractSpace: upgraded, extensions: [extension] })
    ).rejects.toThrow("Interrupted transform");
    const unchanged = await createAutoMigratingIdbClient({
      ...options(factory),
      contractSpace: baseline,
      extensions: [extension],
    });
    expect(await unchanged.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Before" });
    await unchanged.close();

    interrupted = false;
    const resumed = await createAutoMigratingIdbClient({
      ...options(factory),
      contractSpace: upgraded,
      extensions: [extension],
    });
    expect(await resumed.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Migrated" });
    await resumed.orm["users"]!.where({ id: "u1" }).update({ name: "Edited after retry" });
    await resumed.close();
    const reopened = await createAutoMigratingIdbClient({
      ...options(factory),
      contractSpace: upgraded,
      extensions: [extension],
    });
    expect(await reopened.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Edited after retry" });
    await reopened.close();
  });

  it("applies additional same-hash migrations in order without replaying earlier ones", async () => {
    const factory = new IDBFactory();
    const client = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: upgraded });
    await client.orm["users"]!.create({ id: "u1", name: "Before" });
    await client.close();
    const second = dataMigration([transformRecordsOp("users", { fields: { name: setLiteral("Second") } })]);
    const third = dataMigration([transformRecordsOp("users", { fields: { name: setLiteral("Third") } })]);
    const space = { ...upgraded, migrations: [...upgraded.migrations, second, third] };
    const next = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: space });
    expect(await next.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Third" });
    await next.orm["users"]!.where({ id: "u1" }).update({ name: "Edited" });
    await next.close();
    const reopened = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: space });
    expect(await reopened.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Edited" });
    await reopened.close();
  });

  it("keeps the same-hash skip for packages without transforms", async () => {
    const factory = new IDBFactory();
    const old = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: baseline });
    await old.close();
    const ignored = dataMigration([dropObjectStoreOp("users")]);
    const client = await createAutoMigratingIdbClient({
      ...options(factory),
      contractSpace: { ...baseline, migrations: [...baseline.migrations, ignored] },
    });
    await client.orm["users"]!.create({ id: "u1", name: "Unchanged" });
    await client.close();
  });

  it("applies data transforms at an intermediate hash before advancing the schema", async () => {
    const factory = new IDBFactory();
    const old = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: baseline });
    await old.orm["users"]!.create({ id: "u1", name: "Before" });
    await old.close();
    const nextContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: { store: "users", key: "id", fields: { id: "String", name: "String" } },
        Post: { store: "posts", key: "id", fields: { id: "String" } },
      },
    });
    const nextSpace = buildContractSpaceFixture([contract, nextContract]);
    const client = await createAutoMigratingIdbClient({
      ...options(factory),
      contractSpace: { ...nextSpace, migrations: [nextSpace.migrations[0]!, migration, nextSpace.migrations[1]!] },
    });
    expect(await client.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Migrated" });
    await client.orm["posts"]!.create({ id: "p1" });
    await client.close();
  });

  it("rejects tampered same-hash transforms before changing records", async () => {
    const factory = new IDBFactory();
    const old = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: baseline });
    await old.orm["users"]!.create({ id: "u1", name: "Before" });
    await old.close();
    const tampered = { ...migration, metadata: { ...migration.metadata, migrationHash: "wrong" } };
    await expect(
      createAutoMigratingIdbClient({
        ...options(factory),
        contractSpace: { ...baseline, migrations: [...baseline.migrations, tampered] },
      })
    ).rejects.toThrow("failed integrity check");
    const client = await createAutoMigratingIdbClient({ ...options(factory), contractSpace: baseline });
    expect(await client.orm["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Before" });
    await client.close();
  });
});
