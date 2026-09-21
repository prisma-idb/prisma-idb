/**
 * `createManagedAutoSyncIdbClient` — same rationale as client-idb's
 * `createManagedAutoIdbClient` test: hand-composing `createManagedIdbClient`
 * with `createAutoMigratingSyncIdbClient` means writing `dbName` twice with
 * nothing tying the two copies together, so a drift makes `reset()`
 * silently delete the wrong database. This guards that the wrapper closes
 * that gap for the sync-tracked client too.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbSyncExtension } from "../src/exports/control";
import { createManagedAutoSyncIdbClient } from "../src/exports/client";
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
  return `managed-auto-sync-${++dbCounter}`;
}

describe("createManagedAutoSyncIdbClient", () => {
  beforeEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });
  afterEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });

  it("migrates and opens a working sync-tracked client from a single dbName", async () => {
    const space = buildContractSpaceFixture(contract);
    const managed = createManagedAutoSyncIdbClient({
      contractSpace: space,
      dbName: dbName(),
      extensions: [idbSyncExtension],
    });

    const db = await managed.get();
    const orm = db.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
    await orm.users.create({ id: "u1", name: "Alice" });

    const outbox = await db.withTransaction(["_idb_sync_outbox"], async (scope) => {
      return scope.execute({ kind: "cursor-scan", storeName: "_idb_sync_outbox" } as never) as Promise<
        Record<string, unknown>[]
      >;
    });
    expect(outbox).toHaveLength(1);

    await managed.close();
  });

  it("reset() deletes the exact database get() opened", async () => {
    const space = buildContractSpaceFixture(contract);
    const managed = createManagedAutoSyncIdbClient({
      contractSpace: space,
      dbName: dbName(),
      extensions: [idbSyncExtension],
    });

    const db = await managed.get();
    const orm = db.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
    await orm.users.create({ id: "u1", name: "Alice" });

    await managed.reset();

    // If reset() had deleted a differently-named (drifted) database, this
    // row would still be there after re-opening under the same wrapper.
    const reopened = await managed.get();
    const reopenedOrm = reopened.orm as unknown as { users: { all(): { toArray(): Promise<unknown[]> } } };
    expect(await reopenedOrm.users.all().toArray()).toHaveLength(0);
  });
});
