/**
 * A read with `include()` sees one consistent state of the database.
 *
 * The parent rows and every included relation are read in one IndexedDB transaction. If they were read in
 * separate transactions, a write that commits in between (from the sync worker, other app code or another tab)
 * could produce a result that never existed: a parent whose children are already gone, or a child whose required
 * parent reads as `null`.
 *
 * Each test lets the read open its first transaction, then immediately queues a write from outside the ORM, the way
 * another tab would. IndexedDB runs the write after that first transaction and before any transaction the read
 * opens later. So the read must see the state before the write in full.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbClient } from "../src/exports/client";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "cascade" },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String" },
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
      },
    },
  },
});

/** Untyped view of an accessor: `defineContract()` carries no row types, so these fixtures do not need them. */
type Row = Record<string, unknown>;
type LooseAccessor = {
  create(data: Row): Promise<Row>;
  delete(key: string): Promise<Row>;
  include(relation: string): { all(): { toArray(): Promise<Row[]> } };
};
type LooseClient = {
  orm: Record<"users" | "posts", LooseAccessor>;
  transaction<T>(rootKeys: string[], fn: (tx: Record<"users" | "posts", LooseAccessor>) => PromiseLike<T>): Promise<T>;
  close(): void;
};

let dbCounter = 0;

function createStores(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("users", { keyPath: "id" });
      req.result.createObjectStore("posts", { keyPath: "id" }).createIndex("authorId", "authorId");
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * When the read opens its first transaction over `readStore`, queue a raw transaction that deletes Alice and her
 * post. Created right after the read's transaction, it waits for that one and runs before any later transaction.
 */
function deleteAliceOnceReadStarts(readStore: string) {
  const open = IDBDatabase.prototype.transaction;
  let queued = false;
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = open.apply(this, args);
    const [stores, mode] = args;
    const storeList = typeof stores === "string" ? [stores] : [...stores];
    if (!queued && mode !== "readwrite" && storeList.includes(readStore)) {
      queued = true;
      const write = open.call(this, ["users", "posts"], "readwrite");
      write.objectStore("posts").delete("p1");
      write.objectStore("users").delete("u1");
    }
    return tx;
  });
  return { stop: () => spy.mockRestore() };
}

const alice = { id: "u1", name: "Alice" };
const post = { id: "p1", authorId: "u1", title: "First" };

describe("include() reads one consistent state", () => {
  let db: LooseClient;

  beforeEach(async () => {
    const name = `include-read-consistency-${++dbCounter}`;
    await createStores(name);
    db = createIdbClient({ contract, dbName: name }) as unknown as LooseClient;
    await db.orm.users.create(alice);
    await db.orm.posts.create(post);
  });
  afterEach(() => db.close());

  it("returns a parent with the children it had when the read began", async () => {
    const write = deleteAliceOnceReadStarts("users");
    const users = await db.orm.users.include("posts").all().toArray();
    write.stop();

    expect(users).toEqual([{ ...alice, posts: [post] }]);
  });

  it("returns a child with the required parent it had when the read began", async () => {
    const write = deleteAliceOnceReadStarts("posts");
    const posts = await db.orm.posts.include("author").all().toArray();
    write.stop();

    expect(posts).toEqual([{ ...post, author: alice }]);
  });

  it("still reads included relations inside db.transaction()", async () => {
    const users = await db.transaction(["users"], (tx) => tx.users.include("posts").all().toArray());

    expect(users).toEqual([{ ...alice, posts: [post] }]);
  });
});
