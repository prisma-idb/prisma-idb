import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { validateRecord } from "@prisma-idb/target-idb/runtime";
import { idbSyncExtension } from "../src/exports/control";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import { scanAll } from "./helpers";

it("backfills missing outbox fields without changing existing values", async () => {
  const factory = new IDBFactory();
  const dbName = "outbox-field-backfill";
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: { User: { store: "users", key: "id", fields: { id: "String" } } },
  });
  const contractSpace = buildContractSpaceFixture(contract);
  const client = await createAutoMigratingSyncIdbClient({
    factory,
    dbName,
    contractSpace,
    extensions: [
      {
        ...idbSyncExtension,
        contractSpace: {
          ...idbSyncExtension.contractSpace,
          migrations: idbSyncExtension.contractSpace.migrations.slice(0, 1),
        },
      },
    ],
  });
  await client.close();
  const oldRow = {
    id: "legacy",
    entityType: "User",
    operation: "create",
    payload: { id: "u1" },
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    synced: false,
    syncedAt: null,
    lastAttemptedAt: null,
    tries: 0,
    lastError: null,
    retryable: true,
  };
  const existingRow = {
    ...oldRow,
    id: "existing",
    migrationError: "Earlier transform failed",
    versionMetaId: "meta-1",
  };
  const nullRow = { ...oldRow, id: "nulls", migrationError: null, versionMetaId: null };
  expect(validateRecord(idbSyncExtension.contractSpace.contractJson, "OutboxEvent", oldRow).ok).toBe(false);
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("_idb_sync_outbox", "readwrite");
      for (const row of [oldRow, existingRow, nullRow]) tx.objectStore("_idb_sync_outbox").put(row);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
  const upgraded = await createAutoMigratingSyncIdbClient({
    factory,
    dbName,
    contractSpace,
    extensions: [idbSyncExtension],
  });
  try {
    const rows = await scanAll(upgraded, "_idb_sync_outbox");
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row["id"] === "legacy")).toEqual({
      ...oldRow,
      migrationError: null,
      versionMetaId: null,
    });
    expect(rows.find((row) => row["id"] === "existing")).toEqual(existingRow);
    expect(rows.find((row) => row["id"] === "nulls")).toEqual(nullRow);
    for (const row of rows)
      expect(validateRecord(idbSyncExtension.contractSpace.contractJson, "OutboxEvent", row).ok).toBe(true);
  } finally {
    await upgraded.close();
  }
});
