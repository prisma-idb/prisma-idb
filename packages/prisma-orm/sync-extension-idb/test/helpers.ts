/**
 * Shared test scaffolding for sync-extension-idb's test suite.
 *
 * Mirrors client-idb/test/orm.test.ts's pattern: manually create the raw IDB
 * stores via `indexedDB.open`/`createObjectStore` (bypassing the migration
 * CLI entirely — `createSyncIdbClient` only requires the DB to already have
 * the right shape, not that it got there via a real migration), then hand
 * the DB name to `createSyncIdbClient`.
 */
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient } from "../src/exports/client";
import type { SyncIdbClient } from "../src/exports/client";

let dbCounter = 0;
export function testDbName(): string {
  return `sync-extension-idb-test-${++dbCounter}`;
}

type StoreIndex = { name: string; keyPath: string; unique?: boolean };
type StoreSpec = { name: string; keyPath: string; indexes?: StoreIndex[] };

export const USERS_STORE: StoreSpec = { name: "users", keyPath: "id" };
export const POSTS_STORE: StoreSpec = {
  name: "posts",
  keyPath: "id",
  indexes: [{ name: "byAuthorId", keyPath: "authorId" }],
};
export const OUTBOX_STORE: StoreSpec = {
  name: "_idb_sync_outbox",
  keyPath: "id",
};
export const VERSION_META_STORE: StoreSpec = { name: "_idb_sync_version_meta", keyPath: "id" };

export function openTestDb(name: string, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const spec of stores) {
        const os = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
        for (const idx of spec.indexes ?? []) {
          os.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** User 1:N Post (N:1 author, onDelete cascade) — enough shape to exercise sync-executor's key extraction and apply-pull's cascading delete. */
export function testContract(): IdbContract {
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", name: "String" },
        relations: {
          posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
        },
      },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", title: "String", authorId: "String" },
        relations: {
          author: {
            to: "User",
            cardinality: "N:1",
            on: { local: ["authorId"], target: ["id"] },
            onDelete: "cascade",
          },
        },
      },
    },
  }) as unknown as IdbContract;
}

// ── Test-only ORM access helpers ────────────────────────────────────────────

/**
 * Minimal untyped view of an `IdbStoreAccessor`, for tests that don't care
 * about the full generic contract typing. NOTE: `create`/`update` take the
 * record/patch directly — NOT Prisma's nested `{ data: {...} }` shape.
 */
export interface TestStoreAccessor {
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAll(data: Record<string, unknown>[]): { toArray(): Promise<Record<string, unknown>[]> };
  findUnique(key: unknown): Promise<Record<string, unknown> | null>;
  delete(key: unknown): Promise<void>;
  where(filter: Record<string, unknown>): TestStoreAccessor;
  update(patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateAll(patch: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> };
  deleteAll(): { toArray(): Promise<Record<string, unknown>[]> };
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

/** Cast an `orm`/`rawOrm` client to plain-record store accessors for test use. */
export function asAccessors(orm: unknown): Record<string, TestStoreAccessor> {
  return orm as Record<string, TestStoreAccessor>;
}

type AnySyncClient = Awaited<ReturnType<typeof createTestSyncClient>>["client"];

/** Full unfiltered scan of a store via a raw transaction (bypasses the ORM). */
export function scanAll(client: AnySyncClient, storeName: string): Promise<Record<string, unknown>[]> {
  return client.withTransaction([storeName], async (scope) => {
    return scope.execute({ kind: "cursor-scan", storeName } as never) as Promise<Record<string, unknown>[]>;
  });
}

/** Key-get lookup on a store via a raw transaction (bypasses the ORM). */
export async function keyGet(
  client: AnySyncClient,
  storeName: string,
  key: unknown
): Promise<Record<string, unknown> | undefined> {
  const rows = await client.withTransaction([storeName], async (scope) => {
    return scope.execute({ kind: "key-get", storeName, key } as never) as Promise<Record<string, unknown>[]>;
  });
  return rows[0];
}

/** Bootstraps a fresh fake-indexeddb database with the standard test schema + sync stores, then wraps it with createSyncIdbClient. */
export async function createTestSyncClient(options?: {
  trackedModels?: ReadonlyArray<string> | "*";
}): Promise<{ client: SyncIdbClient<IdbContract>; dbName: string; contract: IdbContract }> {
  const name = testDbName();
  const bootstrapDb = await openTestDb(name, [USERS_STORE, POSTS_STORE, OUTBOX_STORE, VERSION_META_STORE]);
  bootstrapDb.close();
  const contract = testContract();
  const client = createSyncIdbClient({
    contract,
    dbName: name,
    trackedModels: options?.trackedModels ?? "*",
  });
  return { client, dbName: name, contract };
}
