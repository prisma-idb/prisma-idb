/**
 * Multi-space auto-migration (ADR 010 — combined single-transaction apply).
 *
 * Covers `createAutoMigratingIdbClient({ extensions: [...] })`: app space +
 * N extension spaces collapse into ONE IDB version bump and ONE
 * `upgradeneeded` transaction, followed by ONE batched marker-write
 * transaction. See `packages/prisma-orm/docs/adrs/ADR 010 - Combined
 * Single-Transaction Multi-Space Apply.md`.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
