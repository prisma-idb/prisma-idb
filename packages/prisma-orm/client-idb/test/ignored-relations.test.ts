/**
 * `@@ignore` models and `@ignore` relations stay in the contract: their stores,
 * foreign keys and referential actions keep working, while the client has no
 * accessor for an ignored model and refuses ignored relations in `include()`
 * and nested writes.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbStorage } from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

class TestExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  readonly #driver: IdbRuntimeDriverInstance;
  constructor(driver: IdbRuntimeDriverInstance) {
    this.#driver = driver;
  }
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const it = this.#driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of it) yield row as Row;
      })()
    );
  }
  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.#driver.transaction(storeNames, mode);
  }
}

/** Opens a database with every store and index of `contract`. */
function openDb(name: string, contract: Contract<IdbStorage>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [storeName, store] of Object.entries(contract.storage.stores)) {
        const created = request.result.createObjectStore(storeName, { keyPath: store.keyPath as string });
        for (const [indexName, index] of Object.entries(store.indexes ?? {})) {
          created.createIndex(indexName, index.keyPath as string, { unique: index.unique ?? false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function allRows(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction([storeName], "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRow(db: IDBDatabase, storeName: string, row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, ignored: true },
        notes: { to: "Note", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
        legacy: { to: "Legacy", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String" },
      // No onDelete: deleting an author with posts is restricted.
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] }, ignored: true },
      },
    },
    Note: {
      store: "notes",
      key: "id",
      fields: { id: "String", userId: "String" },
      relations: {
        user: {
          to: "User",
          cardinality: "N:1",
          on: { local: ["userId"], target: ["id"] },
          onDelete: "cascade",
        },
      },
    },
    Legacy: {
      store: "legacy",
      key: "id",
      fields: { id: "String", userId: "String" },
      relations: {
        user: {
          to: "User",
          cardinality: "N:1",
          on: { local: ["userId"], target: ["id"] },
          onDelete: "cascade",
        },
      },
      ignored: true,
    },
  },
});

type LooseAccessor = {
  create(data: Record<string, unknown>): Promise<unknown>;
  delete(key: unknown): Promise<unknown>;
  include(relation: string): { all(): { toArray(): Promise<unknown[]> } };
};

let counter = 0;

describe("@ignore and @@ignore at runtime", () => {
  let db: IDBDatabase;
  let orm: Record<string, LooseAccessor | undefined>;

  beforeEach(async () => {
    const name = `ignored-relations-${++counter}`;
    db = await openDb(name, contract);
    orm = idbOrm({ contract, executor: new TestExecutor(createIDBRuntimeDriver(name).create()) }) as unknown as Record<
      string,
      LooseAccessor | undefined
    >;
  });
  afterEach(() => db.close());

  it("has no accessor for an ignored model", () => {
    expect(orm["legacy"]).toBeUndefined();
    expect(orm["users"]).toBeDefined();
  });

  it("cascades a delete into an ignored model's store", async () => {
    await orm["users"]!.create({ id: "u1" });
    await putRow(db, "legacy", { id: "l1", userId: "u1" });
    await putRow(db, "legacy", { id: "l2", userId: "u2" });
    await orm["users"]!.delete("u1");
    expect(await allRows(db, "legacy")).toEqual([{ id: "l2", userId: "u2" }]);
  });

  it("restricts a delete through an ignored relation", async () => {
    await orm["users"]!.create({ id: "u1" });
    await orm["posts"]!.create({ id: "p1", authorId: "u1" });
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete User.*child records.*posts/i);
    expect(await allRows(db, "users")).toEqual([{ id: "u1" }]);
  });

  it("checks the foreign key of an ignored relation on create", async () => {
    await expect(orm["posts"]!.create({ id: "p1", authorId: "missing" })).rejects.toThrow(
      "FK violation on relation 'author': no User with id='missing'"
    );
    expect(await allRows(db, "posts")).toEqual([]);
  });

  it.each([
    ["users", "User", "posts"],
    ["users", "User", "legacy"],
    ["posts", "Post", "author"],
  ])("refuses include() of an ignored relation (store %s, %s.%s)", async (store, model, relation) => {
    expect(() => orm[store]!.include(relation)).toThrow(
      `include('${relation}'): relation "${model}.${relation}" is hidden by @ignore or @@ignore, so the client can't read it.`
    );
  });

  it("still includes a visible relation", async () => {
    await orm["users"]!.create({ id: "u1" });
    await orm["notes"]!.create({ id: "n1", userId: "u1" });
    expect(await orm["users"]!.include("notes").all().toArray()).toEqual([
      { id: "u1", notes: [{ id: "n1", userId: "u1" }] },
    ]);
  });

  it("refuses a nested write through an ignored relation", async () => {
    await expect(
      orm["users"]!.create({ id: "u1", posts: (posts: { create(rows: unknown[]): unknown }) => posts.create([]) })
    ).rejects.toThrow(
      'Relation field "posts" on model "User" is hidden by @ignore or @@ignore, so nested writes can\'t use it.'
    );
    expect(await allRows(db, "users")).toEqual([]);
  });
});

describe("referential actions through hidden relations", () => {
  const actionsContract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", slug: "String" },
        indexes: { slug: { keyPath: "slug", unique: true } },
        relations: {
          drafts: {
            to: "Draft",
            cardinality: "1:N",
            on: { local: ["slug"], target: ["authorSlug"] },
            onUpdate: "cascade",
            ignored: true,
          },
          reviews: {
            to: "Review",
            cardinality: "1:N",
            on: { local: ["id"], target: ["reviewerId"] },
            onDelete: "setNull",
            ignored: true,
          },
        },
      },
      Draft: {
        store: "drafts",
        key: "id",
        fields: { id: "String", authorSlug: "String" },
        relations: {
          author: { to: "User", cardinality: "N:1", on: { local: ["authorSlug"], target: ["slug"] }, ignored: true },
        },
      },
      Review: {
        store: "reviews",
        key: "id",
        fields: { id: "String", reviewerId: "String?" },
        relations: {
          reviewer: { to: "User", cardinality: "N:1", on: { local: ["reviewerId"], target: ["id"] }, ignored: true },
        },
      },
    },
  });

  type ActionAccessor = LooseAccessor & {
    where(filter: Record<string, unknown>): { update(patch: Record<string, unknown>): Promise<unknown> };
  };
  let db: IDBDatabase;
  let actionsOrm: Record<string, ActionAccessor | undefined>;

  beforeEach(async () => {
    const name = `ignored-relation-actions-${++counter}`;
    db = await openDb(name, actionsContract);
    actionsOrm = idbOrm({
      contract: actionsContract,
      executor: new TestExecutor(createIDBRuntimeDriver(name).create()),
    }) as unknown as Record<string, ActionAccessor | undefined>;
  });
  afterEach(() => db.close());

  it("sets the foreign key to null through a hidden relation on delete", async () => {
    await actionsOrm["users"]!.create({ id: "u1", slug: "alice" });
    await actionsOrm["reviews"]!.create({ id: "r1", reviewerId: "u1" });
    await actionsOrm["users"]!.delete("u1");
    expect(await allRows(db, "reviews")).toEqual([{ id: "r1", reviewerId: null }]);
  });

  it("cascades an update of the referenced field through a hidden relation", async () => {
    await actionsOrm["users"]!.create({ id: "u1", slug: "alice" });
    await actionsOrm["drafts"]!.create({ id: "d1", authorSlug: "alice" });
    await actionsOrm["users"]!.where({ id: "u1" }).update({ slug: "alicia" });
    expect(await allRows(db, "drafts")).toEqual([{ id: "d1", authorSlug: "alicia" }]);
  });
});
