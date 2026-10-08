import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { openAndUpgrade, readMarker, applyOneDdlOp } from "../src/core/apply-ddl-op";
import {
  createObjectStoreOp,
  createMarkerStoreOp,
  createIndexOp,
  dropIndexOp,
  dropObjectStoreOp,
  transformRecordsOp,
  coerce,
  pipe,
  defaultIfMissing,
  setLiteral,
  type IdbDdlOp,
} from "../src/core/migration-factories";

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open("records");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seed(keyPath: string | string[] = "id") {
  const factory = new IDBFactory();
  await openAndUpgrade({
    factory,
    dbName: "records",
    targetVersion: 1,
    ops: [createMarkerStoreOp(), createObjectStoreOp("users", { keyPath })],
    markers: [{ space: "app", storageHash: "old" }],
  });
  const db = await open(factory);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("users", "readwrite");
    tx.objectStore("users").put({ id: 1, tenant: "a", profile: { id: 1 }, synced: true, obsolete: "old" });
    tx.objectStore("users").put({ id: 2, tenant: "a", profile: { id: 2 }, synced: "invalid", obsolete: "old" });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return factory;
}

async function snapshot(factory: IDBFactory) {
  const db = await open(factory);
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction("users").objectStore("users").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const marker = await readMarker(db, "app");
  const version = db.version;
  db.close();
  return { records, marker, version };
}

const upgrade = (factory: IDBFactory, ops: readonly IdbDdlOp[]) =>
  openAndUpgrade({
    factory,
    dbName: "records",
    targetVersion: 2,
    ops,
    markers: [{ space: "app", storageHash: "new" }],
  });

describe("transformRecords upgrades", () => {
  it("renames, retypes, backfills and removes records before writing the marker", async () => {
    const factory = await seed();
    await upgrade(factory, [
      transformRecordsOp("users", {
        renameFields: { status: "synced" },
        fields: { status: coerce("string"), role: defaultIfMissing("member") },
        removeFields: ["obsolete"],
      }),
    ]);
    const state = await snapshot(factory);
    expect(state.version).toBe(2);
    expect(state.marker?.storageHash).toBe("new");
    expect(state.records).toEqual([
      { id: 1, tenant: "a", profile: { id: 1 }, status: "true", role: "member" },
      { id: 2, tenant: "a", profile: { id: 2 }, status: "invalid", role: "member" },
    ]);
  });

  it("keeps absent fields absent in stored records", async () => {
    const factory = await seed();
    const before = await snapshot(factory);
    await upgrade(factory, [transformRecordsOp("users", { fields: { count: coerce("int"), role: pipe() } })]);
    const state = await snapshot(factory);
    expect(state.records).toStrictEqual(before.records);
    expect(state.version).toBe(2);
    expect(state.marker?.storageHash).toBe("new");
  });

  it("rolls back earlier record updates, structural ops and markers when a later record throws", async () => {
    const factory = await seed();
    const before = await snapshot(factory);
    await expect(
      upgrade(factory, [
        createObjectStoreOp("temporary", { keyPath: "id" }),
        transformRecordsOp("users", { fields: { synced: coerce("int") } }),
      ])
    ).rejects.toThrow("cannot coerce invalid to int");
    expect(await snapshot(factory)).toEqual(before);
    const db = await open(factory);
    expect(db.objectStoreNames.contains("temporary")).toBe(false);
    db.close();
  });

  it("rethrows cursor errors and rolls back when onError is omitted", async () => {
    const factory = await seed();
    const before = await snapshot(factory);
    let completions = 0;
    await expect(
      new Promise<void>((resolve, reject) => {
        const request = factory.open("records", 2);
        let thrown: unknown;
        request.onupgradeneeded = () => {
          const tx = request.transaction!;
          const store = tx.objectStore("users");
          const openCursor = vi.spyOn(store, "openCursor");
          applyOneDdlOp(
            request.result,
            tx,
            transformRecordsOp("users", { fields: { synced: coerce("int") } }),
            () => completions++
          );
          const cursorRequest = openCursor.mock.results[0]!.value as IDBRequest<IDBCursorWithValue | null>;
          openCursor.mockRestore();
          const onSuccess = cursorRequest.onsuccess!;
          // Catch the public executor's rethrow before it escapes the event loop.
          cursorRequest.onsuccess = function (event) {
            try {
              onSuccess.call(this, event);
            } catch (error) {
              thrown = error;
            }
          };
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(thrown ?? request.error);
      })
    ).rejects.toThrow("cannot coerce invalid to int");
    expect(completions).toBe(0);
    expect(await snapshot(factory)).toEqual(before);
  });

  it("rolls back when a cursor update violates an existing unique index", async () => {
    const factory = await seed();
    await upgrade(factory, [createIndexOp("users", "bySynced", { keyPath: "synced", unique: true })]);
    const before = await snapshot(factory);
    await expect(
      openAndUpgrade({
        factory,
        dbName: "records",
        targetVersion: 3,
        ops: [transformRecordsOp("users", { fields: { synced: setLiteral("duplicate") } })],
        markers: [{ space: "app", storageHash: "failed" }],
      })
    ).rejects.toMatchObject({ name: "ConstraintError" });
    expect(await snapshot(factory)).toEqual(before);
  });

  it.each([
    { fields: { id: coerce("string") } },
    { renameFields: { renamed: "id" } },
    { renameFields: { id: "synced" } },
    { removeFields: ["id"] },
  ])("rejects a key mutation before reading records: %j", async (options) => {
    const factory = await seed();
    const before = await snapshot(factory);
    await expect(upgrade(factory, [transformRecordsOp("users", options)])).rejects.toThrow(
      'store "users" cannot change key field "id"'
    );
    expect(await snapshot(factory)).toEqual(before);
  });

  it.each([
    { keyPath: ["tenant", "id"], field: "tenant" },
    { keyPath: "profile.id", field: "profile" },
  ])("protects compound and nested key paths: %j", async ({ keyPath, field }) => {
    const factory = await seed(keyPath);
    await expect(upgrade(factory, [transformRecordsOp("users", { removeFields: [field] })])).rejects.toThrow(
      `key field "${field}"`
    );
    expect((await snapshot(factory)).version).toBe(1);
  });

  it("finishes each cursor before later transforms and structural operations", async () => {
    const factory = await seed();
    const ops = [
      transformRecordsOp("users", { fields: { status: setLiteral("same") } }),
      transformRecordsOp("users", { removeFields: ["status"] }),
      createIndexOp("users", "uniqueStatus", { keyPath: "status", unique: true }),
      createObjectStoreOp("temporary", { keyPath: "id" }),
      dropObjectStoreOp("temporary"),
      dropIndexOp("users", "uniqueStatus"),
    ];
    const events: string[] = [];
    await openAndUpgrade({
      factory,
      dbName: "records",
      targetVersion: 2,
      ops,
      onOperationStart: (op) => events.push(`start:${op.id}`),
      onOperationComplete: (op) => events.push(`done:${op.id}`),
    });
    expect(events).toEqual(ops.flatMap((op) => [`start:${op.id}`, `done:${op.id}`]));
    const state = await snapshot(factory);
    expect(state.records.every((record) => !Object.hasOwn(record as object, "status"))).toBe(true);
  });

  it("completes an empty cursor and every structural no-op exactly once", async () => {
    const factory = new IDBFactory();
    const create = createObjectStoreOp("users", { keyPath: "id" });
    const index = createIndexOp("users", "byId", { keyPath: "id", unique: false });
    const drop = dropIndexOp("users", "byId");
    const dropStore = dropObjectStoreOp("temporary");
    const ops = [
      create,
      create,
      transformRecordsOp("users", { fields: { status: setLiteral(1) } }),
      index,
      index,
      drop,
      drop,
      createObjectStoreOp("temporary", { keyPath: "id" }),
      dropStore,
      dropStore,
    ];
    const counts: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("records", 1);
      request.onupgradeneeded = () => {
        const runNext = (i: number): void => {
          if (i === ops.length) return;
          applyOneDdlOp(request.result, request.transaction!, ops[i]!, () => {
            counts[i] = (counts[i] ?? 0) + 1;
            runNext(i + 1);
          });
        };
        runNext(0);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    expect(counts).toEqual(ops.map(() => 1));
  });
});
