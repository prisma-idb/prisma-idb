import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { applyPull, createSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { testBigSyncServer, testContract, testDb } from "./helpers";

async function browserClient() {
  // IndexedDB has no bigint key type. The client projection retains digit strings.
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      BigUser: { store: "bigUsers", key: "id", fields: { id: "String", name: "String" } },
      BigItem: { store: "bigItems", key: "id", fields: { id: "String", ownerId: "String", name: "String" } },
    },
  }) as unknown as IdbContract;
  const dbName = `wire-key-roundtrip-${crypto.randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      for (const store of ["bigUsers", "bigItems", "_idb_sync_outbox", "_idb_sync_version_meta"]) {
        request.result.createObjectStore(store, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  return createSyncIdbClient({ contract, dbName, trackedModels: "*" });
}

describe("wire-form SQL keys", () => {
  it("rejects another BigInt scope and ownership reassignment", async () => {
    const db = await testDb();
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testBigSyncServer });
    for (const id of [1n, 2n]) await ormRootFor(db, "BigUser").select("id").create({ id, name: "owner" });
    await ormRootFor(db, "BigItem").select("id").create({ id: 11n, ownerId: 1n, name: "first" });
    await ormRootFor(db, "BigItem").select("id").create({ id: 22n, ownerId: 2n, name: "second" });
    expect(
      await adapter.applyPush(db, {
        scopeKey: "1",
        events: [
          {
            id: "wrong-root",
            entityType: "BigUser",
            operation: "update",
            payload: { key: "2", patch: { name: "changed" } },
          },
          { id: "wrong-item", entityType: "BigItem", operation: "delete", payload: { key: "22" } },
          {
            id: "reassign",
            entityType: "BigItem",
            operation: "update",
            payload: { key: "11", patch: { ownerId: "2" } },
          },
        ],
      })
    ).toEqual({
      ok: true,
      results: ["wrong-root", "wrong-item", "reassign"].map((id) => ({
        id,
        success: false,
        error: "SCOPE_VIOLATION",
        retryable: false,
      })),
    });
    expect((await ormRootFor(db, "BigItem").first({ id: 11n }))?.["ownerId"]).toBe(1n);
    expect(await ormRootFor(db, "BigItem").first({ id: 22n })).not.toBeNull();
  });

  it("pushes, pulls and applies BigInt root/scoped keys, including updates and deletes", async () => {
    const db = await testDb();
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testBigSyncServer });
    const scopeKey = "9007199254740993";
    const itemKey = "9007199254740995";
    const outcome = await adapter.applyPush(db, {
      scopeKey,
      events: [
        { id: "root-create", entityType: "BigUser", operation: "create", payload: { id: scopeKey, name: "Ann" } },
        {
          id: "item-create",
          entityType: "BigItem",
          operation: "create",
          payload: { id: itemKey, ownerId: scopeKey, name: "first" },
        },
        {
          id: "root-update",
          entityType: "BigUser",
          operation: "update",
          payload: { key: scopeKey, patch: { name: "Ada" } },
        },
        {
          id: "item-update",
          entityType: "BigItem",
          operation: "update",
          payload: { key: itemKey, patch: { name: "updated" } },
        },
      ],
    });
    expect(outcome).toEqual({
      ok: true,
      results: ["root-create", "item-create", "root-update", "item-update"].map((id) => ({ id, success: true })),
    });
    expect(await ormRootFor(db, "BigItem").first({ id: BigInt(itemKey) })).toEqual({
      id: BigInt(itemKey),
      ownerId: BigInt(scopeKey),
      name: "updated",
    });
    const changelog = await (
      db.orm.public as unknown as { Changelog: { all(): Promise<{ keyPath: unknown }[]> } }
    ).Changelog.all();
    expect(changelog.map((row) => row.keyPath).sort()).toEqual([scopeKey, scopeKey, itemKey, itemKey]);
    expect(() => JSON.stringify(changelog)).not.toThrow();

    const client = await browserClient();
    try {
      const pulled = await adapter.pull(db, { scopeKey });
      expect(pulled.ok).toBe(true);
      if (!pulled.ok) throw new Error("pull failed");
      // HTTP handlers serialize native record values to the established sync wire form.
      const logs = JSON.parse(
        JSON.stringify(pulled.logs, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
      );
      expect(await applyPull(client, logs)).toMatchObject({ applied: 4, skipped: 0, validationFailed: 0 });
      const read = async (storeName: string, key: string) =>
        client.withTransaction([storeName], (scope) => scope.execute({ kind: "key-get", storeName, key } as never));
      expect(await read("bigUsers", scopeKey)).toEqual([{ id: scopeKey, name: "Ada" }]);
      expect(await read("bigItems", itemKey)).toEqual([{ id: itemKey, ownerId: scopeKey, name: "updated" }]);

      expect(
        await adapter.applyPush(db, {
          scopeKey,
          events: [{ id: "item-delete", entityType: "BigItem", operation: "delete", payload: { key: itemKey } }],
        })
      ).toEqual({ ok: true, results: [{ id: "item-delete", success: true }] });
      expect(await ormRootFor(db, "BigItem").first({ id: BigInt(itemKey) })).toBeNull();
      const deleted = await adapter.pull(db, { scopeKey, lastChangelogId: pulled.logs.at(-1)!.changelogId });
      if (!deleted.ok) throw new Error("delete pull failed");
      expect(deleted.logs).toMatchObject([{ keyPath: itemKey, record: null, operation: "delete" }]);
      expect(await applyPull(client, [...deleted.logs])).toMatchObject({ applied: 1, skipped: 0, validationFailed: 0 });
      expect(await read("bigItems", itemKey)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
