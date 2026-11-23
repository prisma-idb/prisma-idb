/**
 * Multi-space auto-migration.
 *
 * Covers `createAutoMigratingIdbClient({ extensions: [...] })`: app space +
 * N extension spaces collapse into ONE IDB version bump and ONE
 * `upgradeneeded` transaction, which also writes every space's marker.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { writeMarkers } from "@prisma-idb/target-idb/runtime";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { autoMigrate } from "../src/core/auto-migrate";
import type { IdbStoreAccessor } from "../src/exports/orm";
import { buildContractSpaceFixture, buildExtensionContractSpaceFixture } from "./_contract-space-fixture";

function asRecord(orm: unknown): Record<string, IdbStoreAccessor<never, never>> {
  return orm as Record<string, IdbStoreAccessor<never, never>>;
}

let dbCounter = 0;
function dbName(): string {
  return `auto-mig-multispace-${++dbCounter}`;
}

async function openRawDb(name: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(name);
    req.onsuccess = (e) => res((e.target as IDBOpenDBRequest).result);
    req.onerror = (e) => rej((e.target as IDBOpenDBRequest).error);
  });
}

/** Seeds pending extension state before an upgrade, waiting for its commit. */
async function seedPendingSyncState(
  name: string,
  pending: Record<string, unknown>,
  version: Record<string, unknown>
): Promise<void> {
  const db = await openRawDb(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["_idb_sync_outbox", "_idb_sync_version_meta"], "readwrite");
      tx.objectStore("_idb_sync_outbox").put(pending);
      tx.objectStore("_idb_sync_version_meta").put(version);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Reads opaque extension rows and markers without the app ORM's model projection. */
function readStores(db: IDBDatabase, stores: string[]): Promise<unknown[][]> {
  return Promise.all(
    stores.map(
      (storeName) =>
        new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(storeName).objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error);
        })
    )
  );
}

const appV1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
  },
});

const syncV1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    OutboxEvent: { store: "_idb_sync_outbox", key: "id", fields: { id: "String", entityType: "String" } },
    VersionMeta: { store: "_idb_sync_version_meta", key: "id", fields: { id: "String", model: "String" } },
  },
});

/** App and extension successors add indexes without replacing stores. */
const appV2 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", email: "String" },
      indexes: { byEmail: { keyPath: "email", unique: true } },
    },
  },
});
const syncV2 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    OutboxEvent: {
      store: "_idb_sync_outbox",
      key: "id",
      fields: { id: "String", entityType: "String" },
      indexes: { byEntityType: { keyPath: "entityType" } },
    },
    VersionMeta: { store: "_idb_sync_version_meta", key: "id", fields: { id: "String", model: "String" } },
  },
});

const otherExtV1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Widget: { store: "_other_ext_widgets", key: "id", fields: { id: "String" } },
  },
});

function syncExtension(): IdbExtensionSpace {
  return { spaceId: "idb-sync", contractSpace: buildExtensionContractSpaceFixture("idb-sync", [syncV1]) };
}

function otherExtension(): IdbExtensionSpace {
  return { spaceId: "other-ext", contractSpace: buildExtensionContractSpaceFixture("other-ext", [otherExtV1]) };
}

describe("auto-migrate combined multi-space apply", () => {
  beforeEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });
  afterEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });

  it("fresh DB: app + one extension migrate in a single version bump", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);

    const client = await createAutoMigratingIdbClient({
      contractSpace: appSpace,
      dbName: name,
      extensions: [syncExtension()],
    });
    await asRecord(client.orm)["users"]!.create({ id: "u1", email: "alice@example.com" });
    await client.close();

    const db = await openRawDb(name);
    // A fresh DB's marker-read open (`openAndReadMarkers`'s bare
    // `factory.open(dbName)`) implicitly creates it at version 1 before any
    // migration runs; the combined apply then bumps it to 2 — one bump
    // total, regardless of how many spaces had pending work (the old
    // per-space loop would have reached 3 here: one bump per space).
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains("_prisma_next_marker")).toBe(true);
    expect(db.objectStoreNames.contains("users")).toBe(true);
    expect(db.objectStoreNames.contains("_idb_sync_outbox")).toBe(true);
    expect(db.objectStoreNames.contains("_idb_sync_version_meta")).toBe(true);

    const markerTx = db.transaction("_prisma_next_marker", "readonly");
    const markerStore = markerTx.objectStore("_prisma_next_marker");
    const appMarker = await new Promise((res, rej) => {
      const req = markerStore.get("app");
      req.onsuccess = () => res(req.result as { storageHash: string } | undefined);
      req.onerror = () => rej(req.error);
    });
    const syncMarker = await new Promise((res, rej) => {
      const req = markerStore.get("idb-sync");
      req.onsuccess = () => res(req.result as { storageHash: string } | undefined);
      req.onerror = () => rej(req.error);
    });
    db.close();

    expect((appMarker as { storageHash: string } | undefined)?.storageHash).toBe(appSpace.headRef.hash);
    expect((syncMarker as { storageHash: string } | undefined)?.storageHash).toBe(
      syncExtension().contractSpace.headRef.hash
    );
  });

  it("fresh DB: app + two extensions all migrate in a single version bump", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);

    const client = await createAutoMigratingIdbClient({
      contractSpace: appSpace,
      dbName: name,
      extensions: [syncExtension(), otherExtension()],
    });
    await client.close();

    const db = await openRawDb(name);
    expect(db.version).toBe(2); // one bump total for all three spaces (see comment above)
    expect(db.objectStoreNames.contains("users")).toBe(true);
    expect(db.objectStoreNames.contains("_idb_sync_outbox")).toBe(true);
    expect(db.objectStoreNames.contains("_other_ext_widgets")).toBe(true);
    db.close();
  });

  it("extension added later to an already-bootstrapped app: only the extension bumps the version", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);

    // Day 1: app-only deployment.
    const c1 = await createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name });
    await asRecord(c1.orm)["users"]!.create({ id: "u1", email: "alice@example.com" });
    await c1.close();

    const dbAfterDay1 = await openRawDb(name);
    const versionAfterDay1 = dbAfterDay1.version;
    dbAfterDay1.close();

    // Day 2: sync extension added. App space is already at head — only the
    // extension has pending ops, so the single combined apply still bumps
    // the version by exactly one (not zero, not two).
    const c2 = await createAutoMigratingIdbClient({
      contractSpace: appSpace,
      dbName: name,
      extensions: [syncExtension()],
    });
    expect(await asRecord(c2.orm)["users"]!.all().toArray()).toHaveLength(1); // data preserved
    await c2.close();

    const dbAfterDay2 = await openRawDb(name);
    expect(dbAfterDay2.version).toBe(versionAfterDay1 + 1);
    expect(dbAfterDay2.objectStoreNames.contains("_idb_sync_outbox")).toBe(true);
    dbAfterDay2.close();
  });

  it.each([
    { name: "app", appVersions: [appV1, appV2], extensionVersions: [syncV1] },
    { name: "extension", appVersions: [appV1], extensionVersions: [syncV1, syncV2] },
    { name: "combined app and extension", appVersions: [appV1, appV2], extensionVersions: [syncV1, syncV2] },
  ])(
    "preserves pending outbox writes and version metadata across $name upgrades",
    async ({ appVersions, extensionVersions }) => {
      const name = dbName();
      const initial = await createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1]),
        dbName: name,
        extensions: [syncExtension()],
      });
      await asRecord(initial.orm)["users"]!.create({ id: "u1", email: "pending@example.com" });
      await initial.close();
      // Extension rows are opaque to the core migrator. An upgrade must preserve
      // unsent payloads and version bookkeeping, including fields it does not own.
      const pending = {
        id: "event-1",
        entityType: "User",
        status: "pending",
        payload: { id: "u1", email: "pending@example.com" },
        retries: 2,
      };
      const version = { id: "User:u1", model: "User", serverVersion: 7, localVersion: 9 };
      await seedPendingSyncState(name, pending, version);

      const client = await createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture(appVersions),
        dbName: name,
        extensions: [
          { spaceId: "idb-sync", contractSpace: buildExtensionContractSpaceFixture("idb-sync", extensionVersions) },
        ],
      });
      try {
        expect(await asRecord(client.orm)["users"]!.all().toArray()).toEqual([
          { id: "u1", email: "pending@example.com" },
        ]);
      } finally {
        await client.close();
      }
      const upgraded = await openRawDb(name);
      try {
        const stored = await readStores(upgraded, [
          "_idb_sync_outbox",
          "_idb_sync_version_meta",
          "_prisma_next_marker",
        ]);
        expect(stored[0]).toEqual([pending]);
        expect(stored[1]).toEqual([version]);
        expect(stored[2]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ space: "app", storageHash: appVersions.at(-1)!.storage.storageHash }),
            expect.objectContaining({ space: "idb-sync", storageHash: extensionVersions.at(-1)!.storage.storageHash }),
          ])
        );
        expect(upgraded.transaction("users").objectStore("users").indexNames.contains("byEmail")).toBe(
          appVersions.length === 2
        );
        const outbox = upgraded.transaction("_idb_sync_outbox").objectStore("_idb_sync_outbox");
        expect(outbox.indexNames.contains("byEntityType")).toBe(extensionVersions.length === 2);
        if (extensionVersions.length === 2) expect(outbox.index("byEntityType").keyPath).toBe("entityType");
      } finally {
        upgraded.close();
      }
    }
  );

  it("repeated open with an already-migrated extension is a no-op (no version bump)", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);
    const ext = syncExtension();

    const c1 = await createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name, extensions: [ext] });
    await c1.close();

    const dbAfterFirst = await openRawDb(name);
    const versionAfterFirst = dbAfterFirst.version;
    dbAfterFirst.close();

    const c2 = await createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name, extensions: [ext] });
    await c2.close();

    const db = await openRawDb(name);
    expect(db.version).toBe(versionAfterFirst); // no-op: nothing pending, no bump
    db.close();
  });

  it("descriptor self-consistency: throws if an extension's headRef doesn't match its contractJson hash", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);
    const ext = syncExtension();
    const tampered: IdbExtensionSpace = {
      spaceId: ext.spaceId,
      contractSpace: { ...ext.contractSpace, headRef: { hash: "sha256:not-the-real-hash", invariants: [] } },
    };

    await expect(
      createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name, extensions: [tampered] })
    ).rejects.toThrow(/internally inconsistent/i);
  });

  it("validates all descriptors before opening the database", async () => {
    const open = vi.fn(() => {
      throw new Error("database must not open");
    });
    const factory = { open } as unknown as IDBFactory;
    const ext = syncExtension();
    const inconsistent = {
      ...ext,
      contractSpace: { ...ext.contractSpace, headRef: { hash: "wrong", invariants: [] } },
    };
    await expect(
      createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1]),
        dbName: dbName(),
        factory,
        extensions: [inconsistent, inconsistent],
      })
    ).rejects.toThrow(/duplicate or reserved/i);
    await expect(
      createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1]),
        dbName: dbName(),
        factory,
        extensions: [inconsistent],
      })
    ).rejects.toThrow(/internally inconsistent/i);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects an extension using the reserved app space ID", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);
    const ext = syncExtension();
    const reserved: IdbExtensionSpace = { spaceId: "app", contractSpace: ext.contractSpace };

    await expect(
      createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name, extensions: [reserved] })
    ).rejects.toThrow(/duplicate or reserved/i);
  });

  it("rejects two extensions sharing the same space ID", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);
    const first = syncExtension();
    const duplicate: IdbExtensionSpace = { spaceId: first.spaceId, contractSpace: otherExtension().contractSpace };

    await expect(
      createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name, extensions: [first, duplicate] })
    ).rejects.toThrow(/duplicate or reserved/i);
  });
});

describe("concurrent auto-migrating opens", () => {
  it("brings every caller's spaces to their heads when two opens race for the same version", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);
    // Both calls read version 0 and plan version 1; only the first one's upgrade can run at version 1.
    const [plain, withSync] = await Promise.all([
      createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name }),
      createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name, extensions: [syncExtension()] }),
    ]);
    await Promise.all([plain.close(), withSync.close()]);

    const db = await openRawDb(name);
    try {
      expect([...db.objectStoreNames].sort()).toEqual([
        "_idb_sync_outbox",
        "_idb_sync_version_meta",
        "_prisma_next_marker",
        "users",
      ]);
      const [markers] = await readStores(db, ["_prisma_next_marker"]);
      expect((markers as { space: string }[]).map((marker) => marker.space).sort()).toEqual(["app", "idb-sync"]);
    } finally {
      db.close();
    }
  });

  /**
   * A factory whose versioned opens all lose the race with VersionError. Before refusing the
   * open on attempt `competeOn`, it lets `compete` run in full, as a competing upgrade would.
   */
  function losingFactory(
    competeOn: number,
    compete: () => Promise<void>
  ): { factory: IDBFactory; attempts: () => number } {
    let attempts = 0;
    const factory = new Proxy(indexedDB, {
      get(target, property) {
        if (property !== "open") return Reflect.get(target, property, target);
        return (name: string, version?: number) => {
          if (version === undefined) return target.open(name);
          const request = { error: new DOMException("Another connection upgraded first.", "VersionError") } as {
            error: DOMException;
            onerror?: (event: { target: unknown }) => void;
          };
          const before = ++attempts === competeOn ? compete() : Promise.resolve();
          void before.then(() => request.onerror?.({ target: request }));
          return request;
        };
      },
    });
    return { factory, attempts: () => attempts };
  }

  it("gives up after five lost races while a space is still behind its head", async () => {
    const { factory, attempts } = losingFactory(0, async () => {});
    await expect(
      autoMigrate({ contractSpace: buildContractSpaceFixture([appV1]), dbName: dbName(), factory })
    ).rejects.toThrow(/did not reach the head of space\(s\) app after 5 attempts/);
    expect(attempts()).toBe(5);
  });

  it("succeeds when the upgrade that won its last attempt brought every space to its head", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1]);
    const { factory, attempts } = losingFactory(5, async () => {
      const winner = await createAutoMigratingIdbClient({ contractSpace: appSpace, dbName: name });
      await winner.close();
    });
    await autoMigrate({ contractSpace: appSpace, dbName: name, factory });
    expect(attempts()).toBe(5);
  });

  it("rejects when app and extension heads only match across different committed states", async () => {
    const name = dbName();
    const appSpace = buildContractSpaceFixture([appV1, appV2]);
    const extension = syncExtension();
    const initial = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([appV1]),
      dbName: name,
    });
    await initial.close();

    const writer = await openRawDb(name);
    let afterLastRace = false;
    let switched: Promise<void> | undefined;
    const { factory } = losingFactory(5, async () => {
      await writeMarkers(writer, [{ space: "app", storageHash: appSpace.headRef.hash }]);
      afterLastRace = true;
    });

    // Queue a competing write after the first retry read is queued. It can
    // commit between separate read transactions, but cannot split one snapshot.
    const get = IDBObjectStore.prototype.get;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
      const request = get.call(this, key);
      if (afterLastRace && !switched && this.name === "_prisma_next_marker") {
        switched = writeMarkers(writer, [
          { space: "app", storageHash: appV1.storage.storageHash },
          { space: extension.spaceId, storageHash: extension.contractSpace.headRef.hash },
        ]);
      }
      return request;
    });
    try {
      await expect(
        autoMigrate({ contractSpace: appSpace, dbName: name, factory, extensions: [extension] })
      ).rejects.toThrow(/did not reach the head of space\(s\) idb-sync after 5 attempts/);
    } finally {
      getSpy.mockRestore();
      writer.close();
      await switched;
    }
  });
});
