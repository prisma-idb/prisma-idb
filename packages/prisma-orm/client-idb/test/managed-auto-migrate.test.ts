/**
 * `createManagedAutoIdbClient` exists specifically so `dbName` is only
 * written once — hand-composing `createManagedIdbClient(() =>
 * createAutoMigratingIdbClient({ dbName }), { dbName })` has two
 * independent copies of `dbName` with nothing tying them together, so a
 * drift between them makes `reset()` silently delete the wrong database
 * (or nothing) while `get()` keeps opening the real one. These tests guard
 * that the wrapper actually closes that gap.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createManagedAutoIdbClient } from "../src/exports/client-auto";
import type { IdbStoreAccessor } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function asRecord(orm: unknown): Record<string, IdbStoreAccessor<never, never>> {
  return orm as Record<string, IdbStoreAccessor<never, never>>;
}

let dbCounter = 0;
function dbName(): string {
  return `managed-auto-${++dbCounter}`;
}

const v1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  enums: { Role: ["USER", "ADMIN"] },
  models: {
    User: { store: "users", key: "id", fields: { id: "String", email: "String", role: "Role" } },
  },
});

describe("createManagedAutoIdbClient", () => {
  beforeEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });
  afterEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });

  it("reads enums without IndexedDB, then migrates and opens the client", async () => {
    const browserFactory = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, "indexedDB");
    const name = dbName();
    const space = buildContractSpaceFixture([v1]);
    const managed = createManagedAutoIdbClient({ contractSpace: space, dbName: name });

    expect(managed.enums["__unbound__"]!["Role"]!.values).toEqual(["USER", "ADMIN"]);
    globalThis.indexedDB = browserFactory;

    const client = await managed.get();
    expectTypeOf(managed.enums).toEqualTypeOf<typeof client.enums>();
    const users = asRecord(client.orm)["users"]!;
    await users.create({ id: "u1", email: "alice@example.com", role: "USER" });
    expect(await users.findUnique("u1")).toMatchObject({ email: "alice@example.com", role: "USER" });

    await managed.close();
  });

  it("get() shares one open across concurrent callers", async () => {
    const name = dbName();
    const space = buildContractSpaceFixture([v1]);
    const managed = createManagedAutoIdbClient({ contractSpace: space, dbName: name });

    const [a, b] = await Promise.all([managed.get(), managed.get()]);
    expect(a).toBe(b);
  });

  it("reset() deletes the exact database get() opened", async () => {
    const name = dbName();
    const space = buildContractSpaceFixture([v1]);
    const managed = createManagedAutoIdbClient({ contractSpace: space, dbName: name });

    const client = await managed.get();
    const users = asRecord(client.orm)["users"]!;
    await users.create({ id: "u1", email: "alice@example.com", role: "USER" });

    await managed.reset();

    // If `reset()` had deleted a differently-named (drifted) database, this
    // row would still be there — this is exactly the failure mode a manual
    // `dbName` duplication risks and this wrapper is meant to rule out.
    const reopened = await managed.get();
    const reopenedUsers = asRecord(reopened.orm)["users"]!;
    expect(await reopenedUsers.findUnique("u1")).toBeNull();
  });
});
