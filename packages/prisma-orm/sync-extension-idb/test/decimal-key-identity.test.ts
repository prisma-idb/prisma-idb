import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbAtomicPlan } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryExecutorWithTransaction } from "@prisma-idb/client-idb/orm";
import { SyncInterceptorExecutor } from "../src/core/sync-executor";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import { versionMetaMatches } from "../src/core/version-meta";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient } from "../src/exports/client";
import { applyPull, decodePullLog } from "../src/core/apply-pull";
import { planReconciliation, applyReconciliation } from "../src/core/reconcile-rejected";
import { OUTBOX_STORE, VERSION_META_STORE, openTestDb, scanAll, testDbName, changelogId, asAccessors } from "./helpers";

/** Exercise native Decimal keys without changing application or sync store definitions. */
async function setup(compound: boolean) {
  const keyPath = compound ? ["group", "id"] : "id";
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Item: {
        store: "items",
        key: keyPath,
        fields: { id: "Decimal", group: "String", note: "String", amount: "Decimal?" },
        indexes: { byAmount: { keyPath: "amount", unique: true } },
      },
    },
  }) as unknown as IdbContract;
  const dbName = testDbName();
  (
    await openTestDb(dbName, [
      { name: "items", keyPath, indexes: [{ name: "byAmount", keyPath: "amount", unique: true }] },
      OUTBOX_STORE,
      VERSION_META_STORE,
    ])
  ).close();
  const client = createSyncIdbClient({ contract, dbName });
  const key = (id: string) => (compound ? ["a", id] : id);
  const metaId = (id: string) => `Item::${JSON.stringify(key(id))}`;
  const log = (id: string, n = 1, operation: "update" | "delete" = "update") => ({
    model: "Item",
    operation,
    changelogId: changelogId(n),
    keyPath: key(id),
    record: operation === "delete" ? null : { id, group: "a", note: "server", amount: null },
  });
  return { client, contract, dbName, key, metaId, log, items: asAccessors(client.orm)["items"]! };
}

/** Observe storage work at the executor boundary while retaining real transaction behavior. */
async function trackedScope(contract: IdbContract, dbName: string) {
  const driver = createIDBRuntimeDriver(dbName).create();
  const plans: IdbAtomicPlan[] = [];
  const inner: IdbQueryExecutorWithTransaction = {
    query() {
      throw new Error("This fixture uses the transaction interface");
    },
    async transaction(stores, mode) {
      const scope = await driver.transaction(stores, mode);
      return {
        commit: () => scope.commit(),
        rollback: () => scope.rollback(),
        execute(plan) {
          plans.push(plan);
          return scope.execute(plan);
        },
      };
    },
  };
  const executor = new SyncInterceptorExecutor(inner, { contract, trackedModels: "*" });
  return { plans, scope: await executor.transaction(["items"], "readwrite") };
}

describe.each([false, true])("Decimal sync identity (compound: %s)", (compound) => {
  it.each(["delete", "put-merged"] as const)("loads metadata once for a bulk %s", async (write) => {
    const { client, contract, dbName, log } = await setup(compound);
    try {
      await applyPull(client, [log("10", 1), log("20", 2), log("30", 3)]);
      const { scope, plans } = await trackedScope(contract, dbName);
      await scope.execute({ kind: "scan-write", storeName: "items", write, patch: { note: "changed" } } as never);
      await scope.commit();
      expect(
        plans.filter((plan) => plan.storeName === "_idb_sync_version_meta" && plan.kind === "cursor-scan")
      ).toHaveLength(1);
      const metadata = await scanAll(client, "_idb_sync_version_meta");
      expect(metadata).toHaveLength(3);
      expect(metadata.every((meta) => meta["localChangePending"] === true)).toBe(true);
      expect(metadata.map((meta) => meta["lastAppliedChangeId"]).sort()).toEqual([
        changelogId(1),
        changelogId(2),
        changelogId(3),
      ]);
      expect(await scanAll(client, "_idb_sync_outbox")).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it.each([false, true])("refreshes cached metadata on delete/recreate (direct edit: %s)", async (editMetadata) => {
    const { client, contract, dbName, key, metaId } = await setup(compound);
    try {
      const { scope, plans } = await trackedScope(contract, dbName);
      // Another model may share the same key without sharing its identity.
      await scope.execute({
        kind: "put",
        storeName: "_idb_sync_version_meta",
        record: {
          id: 'Other::"10"',
          model: "Other",
          key: "10",
          localChangePending: false,
          lastAppliedChangeId: null,
        },
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "items",
        record: { id: "10", group: "a", note: "first", amount: null },
      } as never);
      if (editMetadata)
        await scope.execute({
          kind: "put",
          storeName: "_idb_sync_version_meta",
          record: {
            id: metaId("10"),
            model: "Item",
            key: key("10"),
            localChangePending: false,
            lastAppliedChangeId: changelogId(7),
          },
        } as never);
      await scope.execute({ kind: "delete", storeName: "items", key: key("10") } as never);
      await scope.execute({
        kind: "add",
        storeName: "items",
        record: { id: "1e1", group: "a", note: "second", amount: null },
      } as never);
      await scope.commit();
      expect(
        plans.filter((plan) => plan.storeName === "_idb_sync_version_meta" && plan.kind === "cursor-scan")
      ).toHaveLength(editMetadata ? 2 : 1);
      expect(await scanAll(client, "items")).toMatchObject([{ id: "10", note: "second" }]);
      const metadata = await scanAll(client, "_idb_sync_version_meta");
      expect(metadata).toHaveLength(2);
      expect(metadata.find((meta) => meta["model"] === "Item")).toMatchObject({
        id: metaId("10"),
        localChangePending: true,
        lastAppliedChangeId: editMetadata ? changelogId(7) : null,
      });
      const events = await scanAll(client, "_idb_sync_outbox");
      expect(events).toHaveLength(3);
      expect(events.every((event) => event["versionMetaId"] === metaId("10"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("accepts a numerically equal pull key/record pair and rejects different identities", async () => {
    const { client, contract, log } = await setup(compound);
    try {
      expect(
        decodePullLog(
          contract,
          { ...log("10"), record: { id: "10.00", group: "a", note: "server", amount: null } },
          false
        )
      ).toMatchObject({ record: { id: "10.00" } });
      expect(
        decodePullLog(contract, { ...log("10"), record: { id: "11", group: "a", note: "server", amount: null } }, false)
      ).toBeNull();
      if (compound)
        expect(
          decodePullLog(
            contract,
            { ...log("10"), record: { id: "10.00", group: "b", note: "server", amount: null } },
            false
          )
        ).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("halts alternate-spelling pulls while a local edit or delete is pending", async () => {
    const { client, items, log } = await setup(compound);
    try {
      await items.create({ id: "10", group: "a", note: "pending" });
      expect(await applyPull(client, [log("10.00")])).toMatchObject({ applied: 0, halted: true });
      expect(await scanAll(client, "items")).toMatchObject([{ id: "10", note: "pending" }]);
      await items.delete(compound ? ["a", "10.0"] : "10.0");
      expect(await scanAll(client, "items")).toEqual([]);
      expect(await applyPull(client, [log("1e1")])).toMatchObject({ applied: 0, halted: true });
      expect(await scanAll(client, "_idb_sync_version_meta")).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("reconciles a rejected write with the local key spelling and metadata references", async () => {
    const { client, contract, items, metaId } = await setup(compound);
    try {
      await items.create({ id: "10", group: "a", note: "local" });
      const event = { id: "event", entityType: "Item", versionMetaId: metaId("10") };
      const reconciliation = planReconciliation(contract, event as never, {
        id: "event",
        success: false,
        record: { id: "10.00", group: "a", note: "server", amount: null },
      });
      expect(reconciliation).not.toBeNull();
      expect(
        planReconciliation(contract, event as never, {
          id: "event",
          success: false,
          record: { id: "11", group: "a", note: "other", amount: null },
        })
      ).toBeNull();
      await client.withTransaction(["items", "_idb_sync_version_meta"], async (scope) => {
        await scope.execute({
          kind: "put",
          storeName: "_idb_sync_version_meta",
          record: {
            id: metaId("10"),
            model: "Item",
            key: compound ? ["a", "10"] : "10",
            localChangePending: false,
            lastAppliedChangeId: null,
          },
        } as never);
        await applyReconciliation(scope, reconciliation!);
      });
      expect(await scanAll(client, "items")).toMatchObject([{ id: "10", note: "server", amount: null }]);
      expect(await scanAll(client, "_idb_sync_version_meta")).toMatchObject([{ id: metaId("10") }]);
    } finally {
      await client.close();
    }
  });

  it("retains one spelling, metadata flag and cursor across alternate pulls and local writes", async () => {
    const { client, items, log, metaId } = await setup(compound);
    try {
      expect(await applyPull(client, [log("10", 2)])).toMatchObject({ applied: 1 });
      expect(await applyPull(client, [log("10.00", 3)])).toMatchObject({ applied: 1 });
      expect(await applyPull(client, [log("1e1", 1)])).toMatchObject({ applied: 0, halted: false });
      expect(await scanAll(client, "items")).toMatchObject([{ id: "10" }]);
      expect(await items.where({ id: "10.00" }).update({ id: "1e1", note: "local" })).toMatchObject({
        id: "10",
        note: "local",
      });
      expect(await scanAll(client, "_idb_sync_version_meta")).toMatchObject([
        { id: metaId("10"), localChangePending: true, lastAppliedChangeId: changelogId(3) },
      ]);
      const events = await scanAll(client, "_idb_sync_outbox");
      expect(events).toMatchObject([
        { versionMetaId: metaId("10"), payload: { key: compound ? ["a", "10"] : "10", patch: { id: "10" } } },
      ]);
    } finally {
      await client.close();
    }
  });

  it("applies numeric deletes and restores the old spelling after a local delete/recreate", async () => {
    const { client, items, log, key, metaId } = await setup(compound);
    try {
      await applyPull(client, [log("10")]);
      expect(await applyPull(client, [log("10.00", 2, "delete")])).toMatchObject({ applied: 1 });
      expect(await scanAll(client, "items")).toEqual([]);
      expect(await items.create({ id: "10.000", group: "a", note: "recreated" })).toMatchObject({ id: "10" });
      expect(await scanAll(client, "_idb_sync_version_meta")).toMatchObject([{ id: metaId("10"), key: key("10") }]);
    } finally {
      await client.close();
    }
  });

  it("halts a unique Decimal collision without saving the row or advancing metadata", async () => {
    const { client, log } = await setup(compound);
    try {
      await applyPull(client, [{ ...log("10"), record: { id: "10", group: "a", note: "one", amount: "20" } }]);
      expect(
        await applyPull(client, [{ ...log("11", 2), record: { id: "11", group: "a", note: "two", amount: "2e1" } }])
      ).toMatchObject({ applied: 0, halted: true });
      expect(await scanAll(client, "items")).toHaveLength(1);
      expect(await scanAll(client, "_idb_sync_version_meta")).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("raises an explicit conflict for legacy application aliases without deleting either row", async () => {
    const { client, dbName, log } = await setup(compound);
    const driver = createIDBRuntimeDriver(dbName).create();
    try {
      const scope = await driver.transaction(["items"], "readwrite");
      for (const id of ["10", "10.00"])
        await scope.execute({
          kind: "add",
          storeName: "items",
          record: { id, group: "a", note: "legacy", amount: null },
        } as never);
      await scope.commit();
      await expect(applyPull(client, [log("1e1")])).rejects.toMatchObject({ code: "DECIMAL_IDENTITY_CONFLICT" });
      expect(await scanAll(client, "items")).toHaveLength(2);
    } finally {
      await driver.close();
      await client.close();
    }
  });

  it("raises an explicit conflict for legacy metadata aliases", async () => {
    const { client, log, key, metaId } = await setup(compound);
    try {
      await client.withTransaction(["_idb_sync_version_meta"], async (scope) => {
        for (const id of ["10", "10.00"])
          await scope.execute({
            kind: "add",
            storeName: "_idb_sync_version_meta",
            record: {
              id: metaId(id),
              model: "Item",
              key: key(id),
              localChangePending: false,
              lastAppliedChangeId: null,
            },
          } as never);
      });
      await expect(applyPull(client, [log("1e1")])).rejects.toMatchObject({ code: "DECIMAL_IDENTITY_CONFLICT" });
      expect(await scanAll(client, "items")).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

it("matches persisted compound metadata ids without flattening Date or Bytes identity", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Item: {
        store: "items",
        key: ["date", "bytes", "id"],
        fields: { date: "DateTime", bytes: "Bytes", id: "Decimal" },
      },
    },
  }) as unknown as IdbContract;
  const date = new Date("2026-10-01T00:00:00Z");
  const bytes = new Uint8Array([1, 2]);
  const id = `Item::${JSON.stringify([date, bytes, "10"])}`;
  expect(versionMetaMatches(contract, "Item", id, [date, bytes, "10.00"])).toBe(true);
  expect(versionMetaMatches(contract, "Item", id, [date, new Uint8Array([1, 3]), "10.00"])).toBe(false);
});
