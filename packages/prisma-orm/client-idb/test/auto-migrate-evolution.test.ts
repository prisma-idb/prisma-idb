/**
 * Auto-migration across contract evolution.
 *
 * `createAutoMigratingIdbClient` consumes a bundled `ContractSpace`
 * (assembled at design time by `prisma-idb migration contract-space`)
 * and walks its `migrations` array from the current marker to `headRef.hash`.
 * The browser-side path never re-runs the planner — it just applies the
 * pre-computed `ops.json` blobs in chain order.
 *
 * These tests construct the contract space in-memory via
 * {@link buildContractSpaceFixture}, simulating what the codegen would emit
 * if the user had run `migration new` once per version.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbStoreAccessor } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function asRecord(orm: unknown): Record<string, IdbStoreAccessor<never, never>> {
  return orm as Record<string, IdbStoreAccessor<never, never>>;
}

let dbCounter = 0;
function dbName(): string {
  return `auto-mig-evolve-${++dbCounter}`;
}

const v1 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
  },
});

const v2 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
    Post: { store: "posts", key: "id", fields: { id: "String", title: "String" } },
  },
});

const v3 = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", email: "String" },
      indexes: { byEmail: { keyPath: "email", unique: true } },
    },
    Post: { store: "posts", key: "id", fields: { id: "String", title: "String" } },
  },
});

describe("auto-migrate across contract evolution", () => {
  beforeEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });
  afterEach(async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  });

  it("v1 → v2 walks an extra migration package without re-creating existing stores", async () => {
    const name = dbName();

    // Day-1 deployment: one migration package (null → v1).
    const space1 = buildContractSpaceFixture([v1]);
    const c1 = await createAutoMigratingIdbClient({ contractSpace: space1, dbName: name });
    const orm1 = asRecord(c1.orm);
    await orm1["users"]!.create({ id: "u1", email: "alice@example.com" });
    await c1.close();

    // Day-2 deployment: chain has both v1 and v2. Tab opens at marker v1,
    // walks the v1→v2 package only.
    const space2 = buildContractSpaceFixture([v1, v2]);
    const c2 = await createAutoMigratingIdbClient({ contractSpace: space2, dbName: name });
    const orm2 = asRecord(c2.orm);
    const users = await orm2["users"]!.all().toArray();
    expect(users).toHaveLength(1); // existing data preserved
    await orm2["posts"]!.create({ id: "p1", title: "Hello" });
    expect(await orm2["posts"]!.all().toArray()).toHaveLength(1);
    await c2.close();
  });

  it("v2 → v3 adds an index without destroying existing rows", async () => {
    const name = dbName();

    const space2 = buildContractSpaceFixture([v1, v2]);
    const c2 = await createAutoMigratingIdbClient({ contractSpace: space2, dbName: name });
    await asRecord(c2.orm)["users"]!.create({ id: "u1", email: "alice@example.com" });
    await c2.close();

    const space3 = buildContractSpaceFixture([v1, v2, v3]);
    const c3 = await createAutoMigratingIdbClient({ contractSpace: space3, dbName: name });
    expect(await asRecord(c3.orm)["users"]!.all().toArray()).toHaveLength(1);
    await c3.close();
  });

  it("repeated open with same contract space is a no-op", async () => {
    const name = dbName();
    const space1 = buildContractSpaceFixture([v1]);

    const c1a = await createAutoMigratingIdbClient({ contractSpace: space1, dbName: name });
    await asRecord(c1a.orm)["users"]!.create({ id: "u1", email: "alice@example.com" });
    await c1a.close();

    const c1b = await createAutoMigratingIdbClient({ contractSpace: space1, dbName: name });
    expect(await asRecord(c1b.orm)["users"]!.all().toArray()).toHaveLength(1);
    await c1b.close();
  });

  it("advances the marker across a zero-op bridge migration (hash-only contract re-emission)", async () => {
    // Simulates re-emitting a contract under a new hashing algorithm with no
    // structural change (e.g. the rc.4→rc.5 storageHash move) — the CLI's
    // `migration plan` bridges this with a real, zero-op migration package.
    // The marker must still advance to the new head once that package is
    // walked, even though there's no DDL to apply.
    const name = dbName();
    const space1 = buildContractSpaceFixture([v1]);
    const c1 = await createAutoMigratingIdbClient({ contractSpace: space1, dbName: name });
    await c1.close();

    const v1Rehashed: typeof v1 = {
      ...v1,
      storage: { ...v1.storage, storageHash: "v1-rehashed" },
    } as unknown as typeof v1;
    const space2 = buildContractSpaceFixture([v1, v1Rehashed]);
    expect(space2.migrations[1]!.ops).toHaveLength(0); // confirm the bridge really is zero-op

    const c2 = await createAutoMigratingIdbClient({ contractSpace: space2, dbName: name });
    expect(await c2.verifyMarker()).toBe(true);
    await c2.close();
  });

  it("uses the factory override for both migration and runtime queries", async () => {
    const fake: { IDBFactory: new () => IDBFactory } = await import("fake-indexeddb");
    const customFactory = new fake.IDBFactory();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();

    const name = dbName();
    const space1 = buildContractSpaceFixture([v1]);
    const client = await createAutoMigratingIdbClient({
      contractSpace: space1,
      dbName: name,
      factory: customFactory,
    });

    await asRecord(client.orm)["users"]!.create({ id: "u1", email: "alice@example.com" });
    expect(await asRecord(client.orm)["users"]!.all().toArray()).toHaveLength(1);
    await client.close();
  });

  it("rejects instead of treating IDB open errors as a fresh install", async () => {
    const request = {
      error: new DOMException("marker open failed", "AbortError"),
      onerror: null as ((event: Event) => void) | null,
      onsuccess: null as ((event: Event) => void) | null,
    };
    const failingFactory = {
      open: () => {
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    await expect(
      createAutoMigratingIdbClient({
        contractSpace: buildContractSpaceFixture([v1]),
        dbName: dbName(),
        factory: failingFactory,
      })
    ).rejects.toThrow(/marker open failed/i);
  });

  it("applies destructive ops as planned, without any opt-in", async () => {
    // Author drops the unique byEmail index. Planned and reviewed at design
    // time, so the browser applies it instead of refusing to open.
    const v3Loosened = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
        Post: { store: "posts", key: "id", fields: { id: "String", title: "String" } },
      },
    });

    const name = dbName();
    const space3 = buildContractSpaceFixture([v1, v2, v3]);
    const c3 = await createAutoMigratingIdbClient({ contractSpace: space3, dbName: name });
    await asRecord(c3.orm)["users"]!.create({ id: "u1", email: "alice@example.com" });
    await c3.close();

    const spaceLoose = buildContractSpaceFixture([v1, v2, v3, v3Loosened]);
    const cLoose = await createAutoMigratingIdbClient({ contractSpace: spaceLoose, dbName: name });
    // The unique index is gone, so a duplicate email is accepted.
    await asRecord(cLoose.orm)["users"]!.create({ id: "u2", email: "alice@example.com" });
    expect(await asRecord(cLoose.orm)["users"]!.all().toArray()).toHaveLength(2);
    await cLoose.close();
  });

  it("broken chain throws with a clear error", async () => {
    const name = dbName();
    // Bootstrap at v1.
    const space1 = buildContractSpaceFixture([v1]);
    const c1 = await createAutoMigratingIdbClient({ contractSpace: space1, dbName: name });
    await c1.close();

    // Build a space whose v1 hash has been replaced (chain doesn't connect
    // to the existing marker). Simulate by reusing v2 + v3 only — the
    // marker says "v1 hash" but the new space has no package whose
    // `from === v1 hash`.
    const broken = buildContractSpaceFixture([v2, v3]);
    await expect(createAutoMigratingIdbClient({ contractSpace: broken, dbName: name })).rejects.toThrow(
      /chain broken/i
    );
  });
});
