/**
 * `createManagedAutoSyncIdbClient` — same rationale as client-idb's
 * `createManagedAutoIdbClient` test: hand-composing `createManagedIdbClient`
 * with `createAutoMigratingSyncIdbClient` means writing `dbName` twice with
 * nothing tying the two copies together, so a drift makes `reset()`
 * silently delete the wrong database. This guards that the wrapper closes
 * that gap for the sync-tracked client too.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { idbSyncExtension } from "../src/exports/control";
import { createManagedAutoSyncIdbClient } from "../src/exports/client";
import { changelogId, asAccessors } from "./helpers";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  enums: { Role: ["USER", "ADMIN"] },
  models: {
    User: { store: "users", key: "id", fields: { id: "String", name: "String", role: "Role" } },
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

  it("reads enums without IndexedDB and opens a sync-tracked client when it becomes available", async () => {
    const browserFactory = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, "indexedDB");
    const space = buildContractSpaceFixture(contract);
    const managed = createManagedAutoSyncIdbClient({
      contractSpace: space,
      dbName: dbName(),
      extensions: [idbSyncExtension],
    });

    expect(managed.enums["__unbound__"]!["Role"]!.members["ADMIN"]).toBe("ADMIN");
    await managed.close();
    globalThis.indexedDB = browserFactory;

    const db = await managed.get();
    expectTypeOf(managed.enums).toEqualTypeOf<typeof db.enums>();
    expectTypeOf(managed.enums).toEqualTypeOf<typeof db.rawClient.enums>();
    const orm = db.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
    await orm.users.create({ id: "u1", name: "Alice", role: "USER" });

    const outbox = await db.withTransaction(["_idb_sync_outbox"], async (scope) => {
      return scope.execute({ kind: "cursor-scan", storeName: "_idb_sync_outbox" } as never) as Promise<
        Record<string, unknown>[]
      >;
    });
    expect(outbox).toHaveLength(1);

    await managed.reset();
  });

  it("resumes the pull cursor after a client reload and clears it with data on reset", async () => {
    const managed = createManagedAutoSyncIdbClient({
      contractSpace: buildContractSpaceFixture(contract),
      dbName: dbName(),
      extensions: [idbSyncExtension],
    });
    const first = await managed.get();
    let finishPull!: () => void;
    let enterPull!: () => void;
    const pulling = new Promise<void>((resolve) => {
      enterPull = resolve;
    });
    const worker = first.createSyncWorker({
      pushHandler: async () => [],
      pullHandler: () =>
        new Promise((resolve) => {
          finishPull = () =>
            resolve([
              {
                changelogId: changelogId(7),
                model: "User",
                operation: "create",
                keyPath: "u1",
                record: { id: "u1", name: "Alice" },
              },
            ]);
          enterPull();
        }),
    });
    const cycle = worker.forceSync();
    await pulling;
    const stopping = worker.stop();
    finishPull();
    await Promise.all([cycle, stopping]);
    await managed.close();

    const from: (string | null)[] = [];
    /** Observe the persisted cursor through the transport after reopening the database. */
    async function pullAfterReopen(): Promise<void> {
      const client = await managed.get();
      const next = client.createSyncWorker({
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return [];
        },
      });
      await next.forceSync();
      await next.stop();
    }
    await pullAfterReopen();
    const reloaded = await managed.get();
    expect(await asAccessors(reloaded.orm)["users"]!.findUnique("u1")).toEqual({ id: "u1", name: "Alice" });
    await managed.reset();
    await pullAfterReopen();
    expect(from).toEqual([changelogId(7), null]);
    const reset = await managed.get();
    expect(await asAccessors(reset.orm)["users"]!.findUnique("u1")).toBeNull();
    await managed.close();
  });

  it("uses an explicit factory to open and reset without a global indexedDB", async () => {
    const factory = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, "indexedDB");
    const space = buildContractSpaceFixture(contract);
    const managed = createManagedAutoSyncIdbClient({
      contractSpace: space,
      dbName: dbName(),
      extensions: [idbSyncExtension],
      factory,
    });

    const db = await managed.get();
    const orm = db.orm as unknown as { users: { create(data: unknown): Promise<unknown> } };
    await orm.users.create({ id: "u1", name: "Alice", role: "USER" });

    await managed.reset();

    // If reset() had deleted a differently-named (drifted) database, this
    // row would still be there after re-opening under the same wrapper.
    const reopened = await managed.get();
    const reopenedOrm = reopened.orm as unknown as { users: { all(): { toArray(): Promise<unknown[]> } } };
    expect(await reopenedOrm.users.all().toArray()).toHaveLength(0);

    await managed.close();
  });
});
