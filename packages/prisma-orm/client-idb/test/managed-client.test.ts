import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbEnums } from "../src/exports/internal";
import { createManagedIdbClient } from "../src/core/managed-client";

const dbName = "managed-client";
const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  enums: { Role: ["USER", "ADMIN"] },
  models: { User: { store: "users", key: "id", fields: { id: "String", role: "Role" } } },
});

/** Open the database used to exercise managed lifecycle behavior. */
function openDatabase(factory: IDBFactory, version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Adapt a real database connection to a client with enum accessors. */
async function openClient(factory = indexedDB) {
  const database = await openDatabase(factory);
  return { enums: createIdbEnums(contract), close: async () => database.close() };
}

afterEach(() => vi.unstubAllGlobals());

describe("createManagedIdbClient factory lifecycle", () => {
  it("reset() deletes from the factory captured before an in-flight open, even after close()", async () => {
    const original = new IDBFactory();
    const replacement = new IDBFactory();
    vi.stubGlobal("indexedDB", undefined);
    Reflect.deleteProperty(globalThis, "indexedDB");
    const managed = createManagedIdbClient(() => openClient(), { enums: createIdbEnums(contract), dbName });
    expect(managed.enums["__unbound__"]!["Role"]!.values).toEqual(["USER", "ADMIN"]);
    expectTypeOf(managed.enums).toEqualTypeOf<Awaited<ReturnType<typeof openClient>>["enums"]>();
    vi.stubGlobal("indexedDB", original);

    const opening = managed.get();
    vi.stubGlobal("indexedDB", replacement);
    await opening;
    await managed.close();
    await managed.reset();

    expect(await original.databases()).toEqual([]);
  });

  it("reset() without another get() uses the current factory after a successful reset", async () => {
    const original = new IDBFactory();
    const replacement = new IDBFactory();
    vi.stubGlobal("indexedDB", original);
    const managed = createManagedIdbClient(() => openClient(), { enums: createIdbEnums(contract), dbName });
    await managed.get();
    await managed.reset();

    (await openDatabase(replacement)).close();
    vi.stubGlobal("indexedDB", replacement);
    await managed.reset();

    expect(await replacement.databases()).toEqual([]);
  });

  it("get() retries a failed open with the new factory and reset() deletes that database", async () => {
    const original = new IDBFactory();
    const replacement = new IDBFactory();
    (await openDatabase(original, 2)).close();
    vi.stubGlobal("indexedDB", original);
    const managed = createManagedIdbClient(() => openClient(), { enums: createIdbEnums(contract), dbName });

    await expect(managed.get()).rejects.toMatchObject({ name: "VersionError" });
    vi.stubGlobal("indexedDB", replacement);
    await managed.get();
    vi.stubGlobal("indexedDB", original);
    await managed.reset();

    expect(await replacement.databases()).toEqual([]);
    expect(await original.databases()).toEqual([{ name: dbName, version: 2 }]);
  });

  it("uses an explicit factory when the global factory changes", async () => {
    const original = new IDBFactory();
    const replacement = new IDBFactory();
    (await openDatabase(replacement)).close();
    vi.stubGlobal("indexedDB", replacement);
    const managed = createManagedIdbClient(() => openClient(original), {
      enums: createIdbEnums(contract),
      dbName,
      idbFactory: original,
    });

    await managed.get();
    await managed.reset();

    expect(await original.databases()).toEqual([]);
    expect(await replacement.databases()).toEqual([{ name: dbName, version: 1 }]);
  });
});
