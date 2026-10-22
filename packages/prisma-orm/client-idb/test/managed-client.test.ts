import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedIdbClient } from "../src/core/managed-client";

const dbName = "managed-client";

function openDatabase(factory: IDBFactory, version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openClient(factory = indexedDB) {
  const database = await openDatabase(factory);
  return { close: async () => database.close() };
}

afterEach(() => vi.unstubAllGlobals());

describe("createManagedIdbClient factory lifecycle", () => {
  it("reset() deletes from the factory captured before an in-flight open, even after close()", async () => {
    const original = new IDBFactory();
    const replacement = new IDBFactory();
    vi.stubGlobal("indexedDB", undefined);
    const managed = createManagedIdbClient(() => openClient(), { dbName });
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
    const managed = createManagedIdbClient(() => openClient(), { dbName });
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
    const managed = createManagedIdbClient(() => openClient(), { dbName });

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
      dbName,
      idbFactory: original,
    });

    await managed.get();
    await managed.reset();

    expect(await original.databases()).toEqual([]);
    expect(await replacement.databases()).toEqual([{ name: dbName, version: 1 }]);
  });
});
