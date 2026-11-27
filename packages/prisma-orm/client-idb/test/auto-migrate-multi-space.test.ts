/**
 * Multi-space auto-migration.
 *
 * Covers `createAutoMigratingIdbClient({ extensions: [...] })`: app space +
 * N extension spaces collapse into ONE IDB version bump and ONE
 * `upgradeneeded` transaction, which also writes every space's marker.
 */
import "fake-indexeddb/auto";
import { createObjectStoreOp } from "@prisma-idb/target-idb/migration";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { openAndUpgrade, readMarker, writeMarker } from "@prisma-idb/target-idb/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
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
    // A fresh DB's marker-read open (`openAndReadMarker`'s bare
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

  it("rejects an app upgrade into an installed extension's store and preserves both spaces", async () => {
    const name = dbName();
    // The old contract stores @@map("no\u0074es") verbatim. The new one decodes it to "notes".
    const oldStore = String.raw`no\u0074es`;
    const appBefore = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { AppNote: { store: oldStore, key: "id", fields: { id: "String" } } },
    });
    const appAfter = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { AppNote: { store: "notes", key: "id", fields: { id: "String" } } },
    });
    const extensionContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { ExtensionNote: { store: "notes", key: "id", fields: { id: "String" } } },
    });
    const extensions = [
      { spaceId: "ext-notes", contractSpace: buildExtensionContractSpaceFixture("ext-notes", [extensionContract]) },
    ];
    const client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([appBefore]),
      dbName: name,
      extensions,
    });
    await client.close();

    const stores = [oldStore, "notes", "_prisma_next_marker"];
    const originalDb = await openRawDb(name);
    const originalVersion = originalDb.version;
    let originalRows: unknown[][];
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = originalDb.transaction(stores, "readwrite");
        tx.objectStore(oldStore).put({ id: "app" });
        tx.objectStore("notes").put({ id: "extension" });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      originalRows = await readStores(originalDb, stores);
    } finally {
      originalDb.close();
    }

    await expect(
      createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appBefore, appAfter]),
        dbName: name,
        extensions,
      })
    ).rejects.toThrow('Store "notes" is used by contract spaces "app" and "ext-notes".');

    const db = await openRawDb(name);
    try {
      expect(db.version).toBe(originalVersion);
      expect(await readStores(db, stores)).toEqual(originalRows);
    } finally {
      db.close();
    }
  });

  it.each(["fresh database", "extension at an earlier marker", "extension already at head"])(
    "allows the app to claim a store released by an extension on %s",
    async (initialState) => {
      const name = dbName();
      const extensionBefore = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { ExtensionNote: { store: "notes", key: "id", fields: { id: "String", legacyLabel: "String?" } } },
      });
      const extensionWithoutLabel = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { ExtensionNote: { store: "notes", key: "id", fields: { id: "String" } } },
      });
      const extensionAfter = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { ExtensionNote: { store: "extensionNotes", key: "id", fields: { id: "String" } } },
      });
      const appAfter = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
          Note: { store: "notes", key: "id", fields: { id: "String" } },
        },
      });
      const spaceId = "ext-notes";
      const onTransformRecords = vi.fn(() => {
        throw new Error("The extension's transform reached an app hook");
      });
      const extensionHistory = [extensionBefore, extensionWithoutLabel, extensionAfter];
      function extensions(versionCount: number) {
        return [
          {
            spaceId,
            onTransformRecords,
            contractSpace: buildExtensionContractSpaceFixture(spaceId, extensionHistory.slice(0, versionCount)),
          },
        ];
      }
      if (initialState !== "fresh database") {
        const initialVersions = initialState === "extension already at head" ? extensionHistory.length : 1;
        const before = await createAutoMigratingIdbClient({
          contractSpace: buildContractSpaceFixture([appV1]),
          dbName: name,
          extensions: extensions(initialVersions),
        });
        await before.close();
      }
      const finalApp =
        initialState === "fresh database"
          ? buildContractSpaceFixture([appAfter])
          : buildContractSpaceFixture([appV1, appAfter]);
      const client = await createAutoMigratingIdbClient({
        contractSpace: finalApp,
        dbName: name,
        extensions: extensions(extensionHistory.length),
      });
      try {
        await asRecord(client.orm)["notes"]!.create({ id: "app-note" });
      } finally {
        await client.close();
      }

      expect(onTransformRecords).not.toHaveBeenCalled();
      const db = await openRawDb(name);
      try {
        expect(await readStores(db, ["notes", "extensionNotes"])).toEqual([[{ id: "app-note" }], []]);
        expect(await readMarker(db, "app")).toMatchObject({ storageHash: appAfter.storage.storageHash });
        expect(await readMarker(db, spaceId)).toMatchObject({ storageHash: extensionAfter.storage.storageHash });
      } finally {
        db.close();
      }
    }
  );

  it.each(["directly", "after a marker-only app upgrade"])(
    "preserves rows when replaying an interrupted handoff %s",
    async (retry) => {
      const name = dbName();
      const spaceId = "ext-notes";
      const extensionBefore = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { ExtensionNote: { store: "notes", key: "id", fields: { id: "String" } } },
      });
      const extensionAfter = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { ExtensionNote: { store: "extensionNotes", key: "id", fields: { id: "String" } } },
      });
      const appAfter = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
          Note: { store: "notes", key: "id", fields: { id: "String" } },
        },
      });
      const before = await createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1]),
        dbName: name,
        extensions: [{ spaceId, contractSpace: buildExtensionContractSpaceFixture(spaceId, [extensionBefore]) }],
      });
      await before.close();

      const app = buildContractSpaceFixture([appV1, appAfter]);
      const extension = buildExtensionContractSpaceFixture(spaceId, [extensionBefore, extensionAfter]);
      const dbBefore = await openRawDb(name);
      const targetVersion = dbBefore.version + 1;
      dbBefore.close();
      await openAndUpgrade({
        factory: indexedDB,
        dbName: name,
        targetVersion,
        ops: [...extension.migrations[1]!.ops, ...app.migrations[1]!.ops] as unknown as Parameters<
          typeof openAndUpgrade
        >[0]["ops"],
      });

      const dbAhead = await openRawDb(name);
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = dbAhead.transaction("notes", "readwrite");
          tx.objectStore("notes").put({ id: "app-note" });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        dbAhead.close();
      }

      const appBridge = { ...appV1, storage: { ...appV1.storage, storageHash: "bridge" } } as typeof appV1;
      const appOrigin = retry === "directly" ? appV1 : appBridge;
      let expectedVersion = targetVersion;
      if (retry !== "directly") {
        const bridged = await createAutoMigratingIdbClient({
          contractSpace: buildContractSpaceFixture([appV1, appBridge]),
          dbName: name,
          extensions: [{ spaceId, contractSpace: buildExtensionContractSpaceFixture(spaceId, [extensionBefore]) }],
        });
        await bridged.close();
        expectedVersion += 1;
      }
      const finalApp = retry === "directly" ? app : buildContractSpaceFixture([appV1, appBridge, appAfter]);

      await expect(
        createAutoMigratingIdbClient({
          contractSpace: finalApp,
          dbName: name,
          extensions: [{ spaceId, contractSpace: extension }],
        })
      ).rejects.toThrow(/Cannot transfer existing store "notes".*older migration markers/);

      const db = await openRawDb(name);
      try {
        expect(db.version).toBe(expectedVersion);
        expect(await readStores(db, ["notes"])).toEqual([[{ id: "app-note" }]]);
        expect(await readMarker(db, "app")).toMatchObject({ storageHash: appOrigin.storage.storageHash });
        expect(await readMarker(db, spaceId)).toMatchObject({ storageHash: extensionBefore.storage.storageHash });
      } finally {
        db.close();
      }
    }
  );

  it("releases a store before another extension claims it regardless of locale", async () => {
    const archived = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { Widget: { store: "archivedWidgets", key: "id", fields: { id: "String" } } },
    });
    const releasing = buildExtensionContractSpaceFixture("aa", [otherExtV1, archived]);
    const claiming = buildExtensionContractSpaceFixture("ab", [otherExtV1]);
    const name = dbName();
    const danish = new Intl.Collator("da");
    const comparison = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, other) {
      return danish.compare(this, other);
    });
    try {
      const client = await createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1]),
        dbName: name,
        extensions: [
          { spaceId: "ab", contractSpace: claiming },
          { spaceId: "aa", contractSpace: releasing },
        ],
      });
      await client.close();
    } finally {
      comparison.mockRestore();
    }

    const db = await openRawDb(name);
    try {
      expect(db.objectStoreNames.contains("archivedWidgets")).toBe(true);
      expect(db.objectStoreNames.contains("_other_ext_widgets")).toBe(true);
      expect(await readMarker(db, "aa")).toMatchObject({ storageHash: releasing.headRef.hash });
      expect(await readMarker(db, "ab")).toMatchObject({ storageHash: claiming.headRef.hash });
    } finally {
      db.close();
    }
  });

  it("rejects an extension claiming a store before the app releases it", async () => {
    const name = dbName();
    const extensionContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { ExtensionNote: { store: "users", key: "id", fields: { id: "String" } } },
    });
    const spaceId = "ext-users";
    const extensions = [{ spaceId, contractSpace: buildExtensionContractSpaceFixture(spaceId, [extensionContract]) }];
    const newApp = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { User: { store: "newUsers", key: "id", fields: { id: "String", email: "String" } } },
    });

    const client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([appV1]),
      dbName: name,
    });
    const row = { id: "u1", email: "alice@example.com" };
    await asRecord(client.orm)["users"]!.create(row);
    await client.close();

    await expect(
      createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1, newApp]),
        dbName: name,
        extensions,
      })
    ).rejects.toThrow('Store "users" is used by contract spaces "app" and "ext-users".');

    const db = await openRawDb(name);
    try {
      expect(await readStores(db, ["users"])).toEqual([[row]]);
      expect(db.objectStoreNames.contains("newUsers")).toBe(false);
    } finally {
      db.close();
    }
  });

  it.each(["missing", "behind"])("catches up a %s marker when the app already created its store", async (marker) => {
    const name = dbName();
    const after = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
        Note: { store: "notes", key: "id", fields: { id: "String" } },
      },
    });
    const contractSpace = buildContractSpaceFixture(marker === "missing" ? [after] : [appV1, after]);
    if (marker === "behind") {
      const client = await createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([appV1]),
        dbName: name,
      });
      await client.close();
    }
    const dbBefore = await openRawDb(name);
    const targetVersion = dbBefore.version + 1;
    dbBefore.close();
    await openAndUpgrade({
      factory: indexedDB,
      dbName: name,
      targetVersion,
      ops: contractSpace.migrations.at(-1)!.ops as Parameters<typeof openAndUpgrade>[0]["ops"],
    });
    const db = await openRawDb(name);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("notes", "readwrite");
        tx.objectStore("notes").put({ id: "already-written" });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }

    const recovered = await createAutoMigratingIdbClient({ contractSpace, dbName: name });
    try {
      expect(await asRecord(recovered.orm)["notes"]!.all().toArray()).toEqual([{ id: "already-written" }]);
      expect(await recovered.verifyMarker()).toBe(true);
    } finally {
      await recovered.close();
    }
  });

  it.each(["full history", "head only", "legacy head only"])(
    "keeps a helper store created by an at-head extension with %s",
    async (history) => {
      const name = dbName();
      const extension = otherExtension();
      const helper = "extensionStaging";
      const baseline = extension.contractSpace.migrations[0]!;
      const ops = [...baseline.ops, createObjectStoreOp(helper, { keyPath: "id" })];
      const extensionWithHelper = {
        ...extension,
        contractSpace: {
          ...extension.contractSpace,
          migrations: [
            {
              ...baseline,
              ops,
              metadata: { ...baseline.metadata, migrationHash: computeMigrationHash(baseline.metadata, ops) },
            },
          ],
        },
      };
      const extensions = [extensionWithHelper];
      const before = buildContractSpaceFixture([appV1]);
      const client = await createAutoMigratingIdbClient({ contractSpace: before, dbName: name, extensions });
      await client.close();

      const original = await openRawDb(name);
      const version = original.version;
      const row = { id: "extension-owned" };
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = original.transaction(helper, "readwrite");
          tx.objectStore(helper).put(row);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        if (history === "legacy head only") {
          await writeMarker(original, { space: "app", storageHash: before.headRef.hash });
          await writeMarker(original, { space: extension.spaceId, storageHash: extension.contractSpace.headRef.hash });
        }
      } finally {
        original.close();
      }

      const after = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
          Staging: { store: helper, key: "id", fields: { id: "String" } },
        },
      });
      await expect(
        createAutoMigratingIdbClient({
          contractSpace: buildContractSpaceFixture([appV1, after]),
          dbName: name,
          extensions:
            history === "full history"
              ? extensions
              : [{ ...extension, contractSpace: { ...extension.contractSpace, migrations: [] } }],
        })
      ).rejects.toThrow(
        history === "full history"
          ? 'Store "extensionStaging" is used by contract spaces "other-ext" and "app".'
          : 'existing store "extensionStaging" has no owner at the applied migration markers'
      );

      const db = await openRawDb(name);
      try {
        expect(db.version).toBe(version);
        expect(await readStores(db, [helper])).toEqual([[row]]);
        expect(await readMarker(db, "app")).toMatchObject({ storageHash: before.headRef.hash });
      } finally {
        db.close();
      }
    }
  );

  it("rejects an upgrade when another space writes a marker after planning", async () => {
    const name = dbName();
    const app = buildContractSpaceFixture([appV1]);
    const client = await createAutoMigratingIdbClient({ contractSpace: app, dbName: name });
    await client.close();

    const priorDb = await openRawDb(name);
    const currentVersion = priorDb.version + 1;
    priorDb.close();
    await openAndUpgrade({
      factory: indexedDB,
      dbName: name,
      targetVersion: currentVersion,
      ops: [createObjectStoreOp("notes", { keyPath: "id" })],
    });
    const db = await openRawDb(name);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("notes", "readwrite");
        tx.objectStore("notes").put({ id: "extension-note" });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });

      const appAfter = defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
          Note: { store: "notes", key: "id", fields: { id: "String" } },
        },
      });
      let lateMarker: Promise<void> | undefined;
      const factory = {
        open(dbName: string, version?: number) {
          if (version !== undefined) {
            lateMarker = writeMarker(db, { space: "ext-notes", storageHash: "extension-head" });
            db.close();
          }
          return indexedDB.open(dbName, version);
        },
      } as IDBFactory;

      await expect(
        createAutoMigratingIdbClient({
          contractSpace: buildContractSpaceFixture([appV1, appAfter]),
          dbName: name,
          factory,
        })
      ).rejects.toThrow(/migration markers changed.*Open the client again/);
      await lateMarker;
    } finally {
      db.close();
    }

    const reopened = await openRawDb(name);
    try {
      expect(reopened.version).toBe(currentVersion);
      expect(await readStores(reopened, ["notes"])).toEqual([[{ id: "extension-note" }]]);
      expect(await readMarker(reopened, "app")).toMatchObject({ storageHash: app.headRef.hash });
      expect(await readMarker(reopened, "ext-notes")).toMatchObject({ storageHash: "extension-head" });
    } finally {
      reopened.close();
    }
  });

  it("rejects taking over an installed store whose extension is no longer configured", async () => {
    const name = dbName();
    const extension = otherExtension();
    const before = buildContractSpaceFixture([appV1]);
    const client = await createAutoMigratingIdbClient({ contractSpace: before, dbName: name, extensions: [extension] });
    await client.close();

    const store = "_other_ext_widgets";
    const after = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
        Widget: { store, key: "id", fields: { id: "String" } },
      },
    });
    await expect(
      createAutoMigratingIdbClient({ contractSpace: buildContractSpaceFixture([appV1, after]), dbName: name })
    ).rejects.toThrow('existing store "_other_ext_widgets" has no owner at the applied migration markers');

    const db = await openRawDb(name);
    try {
      expect(db.objectStoreNames.contains(store)).toBe(true);
      expect(await readMarker(db, "app")).toMatchObject({ storageHash: before.headRef.hash });
      expect(await readMarker(db, extension.spaceId)).toMatchObject({
        storageHash: extension.contractSpace.headRef.hash,
      });
    } finally {
      db.close();
    }
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
