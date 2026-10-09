/**
 * `db.transaction()` — typed multi-model transactions.
 *
 * Covers:
 *   commit / rollback       — both models written or neither; return value passes through
 *   reads                   — a transaction sees its own uncommitted writes
 *   store expansion         — FK checks, cascades and `include` reach stores the caller did not list
 *   abort rules             — a failed operation aborts the transaction even when the callback catches it
 *   ADR 005                 — awaiting a timer ends the transaction; the error says writes may be committed
 *   lifetime                — `tx` is dead after the callback; only listed models exist on it
 *
 * Compile-time typing is covered by orm-transaction-types.test.ts.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { IdbExecuteError } from "@prisma-idb/driver-idb/runtime";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import { OpenTransaction } from "../src/core/open-transaction";
import { createIdbClient, IdbTransactionCommittedEarlyError } from "../src/exports/client";

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
    Tag: {
      store: "tags",
      key: "id",
      fields: { id: "String", label: "String" },
    },
  },
});

/** Untyped view of an accessor: `defineContract()` carries no row types, so these fixtures do not need them. */
type Row = Record<string, unknown>;
type LooseAccessor = {
  create(data: Row): Promise<Row>;
  findUnique(key: string): Promise<Row | null>;
  delete(key: string): Promise<void>;
  all(): { toArray(): Promise<Row[]> };
  where(filter: Row): { all(): { toArray(): Promise<Row[]> } };
  include(relation: string): { all(): { toArray(): Promise<Row[]> } };
};
type LooseTx = Record<"users" | "posts" | "tags", LooseAccessor>;
type LooseClient = {
  orm: LooseTx;
  transaction<T>(rootKeys: string[], fn: (tx: LooseTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

const STORES = ["users", "posts", "tags"];

let dbCounter = 0;

function createStores(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const store of STORES) req.result.createObjectStore(store, { keyPath: "id" });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("db.transaction()", () => {
  let db: LooseClient;

  beforeEach(async () => {
    const name = `orm-transaction-test-${++dbCounter}`;
    await createStores(name);
    db = createIdbClient({ contract, dbName: name }) as unknown as LooseClient;
  });
  afterEach(() => db.close());

  const userIds = async () => (await db.orm.users.all().toArray()).map((u) => u["id"]);
  const postIds = async () => (await db.orm.posts.all().toArray()).map((p) => p["id"]);

  describe("commit and rollback", () => {
    it("writes every model in one transaction and returns the callback result", async () => {
      const result = await db.transaction(["users", "posts"], async (tx) => {
        const user = await tx.users.create({ id: "u1", name: "Alice" });
        await tx.posts.create({ id: "p1", authorId: user["id"], title: "First" });
        return user["name"];
      });

      expect(result).toBe("Alice");
      expect(await userIds()).toEqual(["u1"]);
      expect(await postIds()).toEqual(["p1"]);
    });

    it("rolls back every write and rethrows when the callback throws", async () => {
      await expect(
        db.transaction(["users", "posts"], async (tx) => {
          await tx.users.create({ id: "u1", name: "Alice" });
          await tx.posts.create({ id: "p1", authorId: "u1", title: "First" });
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      expect(await userIds()).toEqual([]);
      expect(await postIds()).toEqual([]);
    });

    it("sees its own uncommitted writes", async () => {
      await db.transaction(["users", "posts"], async (tx) => {
        await tx.users.create({ id: "u1", name: "Alice" });
        await tx.posts.create({ id: "p1", authorId: "u1", title: "First" });

        expect(await tx.users.findUnique("u1")).toMatchObject({ name: "Alice" });
        expect((await tx.posts.where({ authorId: "u1" }).all().toArray()).map((p) => p["id"])).toEqual(["p1"]);
      });
    });
  });

  describe("stores the caller did not list", () => {
    it("checks foreign keys against a parent store that is not listed", async () => {
      await db.orm.users.create({ id: "u1", name: "Alice" });

      await db.transaction(["posts"], async (tx) => {
        await tx.posts.create({ id: "p1", authorId: "u1", title: "First" });
      });

      expect(await postIds()).toEqual(["p1"]);
    });

    it("includes a related model that is not listed", async () => {
      await db.orm.users.create({ id: "u1", name: "Alice" });
      await db.orm.posts.create({ id: "p1", authorId: "u1", title: "First" });

      const rows = await db.transaction(["posts"], (tx) => tx.posts.include("author").all().toArray());

      expect(rows[0]?.["author"]).toMatchObject({ id: "u1" });
    });

    it("aborts everything when a foreign key is violated", async () => {
      await expect(
        db.transaction(["users", "posts"], async (tx) => {
          await tx.users.create({ id: "u1", name: "Alice" });
          await tx.posts.create({ id: "p1", authorId: "missing", title: "Orphan" });
        })
      ).rejects.toThrow();

      expect(await userIds()).toEqual([]);
      expect(await postIds()).toEqual([]);
    });

    it("rolls a cascade delete back together with a later failure", async () => {
      await db.orm.users.create({ id: "u1", name: "Alice" });
      await db.orm.posts.create({ id: "p1", authorId: "u1", title: "First" });

      await expect(
        db.transaction(["users"], async (tx) => {
          await tx.users.delete("u1");
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      expect(await userIds()).toEqual(["u1"]);
      expect(await postIds()).toEqual(["p1"]);
    });

    it("commits a cascade delete across the listed and the cascaded store", async () => {
      await db.orm.users.create({ id: "u1", name: "Alice" });
      await db.orm.posts.create({ id: "p1", authorId: "u1", title: "First" });

      await db.transaction(["users"], (tx) => tx.users.delete("u1"));

      expect(await userIds()).toEqual([]);
      expect(await postIds()).toEqual([]);
    });
  });

  describe("abort rules", () => {
    it("aborts the transaction when the callback catches a failed operation", async () => {
      await expect(
        db.transaction(["users", "posts"], async (tx) => {
          await tx.users.create({ id: "u1", name: "Alice" });
          await tx.posts.create({ id: "p1", authorId: "missing", title: "Orphan" }).catch(() => undefined);
        })
      ).rejects.toThrow();

      expect(await userIds()).toEqual([]);
    });
  });

  describe("ADR 005: no timers or network inside the callback", () => {
    it("reports that earlier writes were committed when an operation runs after an awaited timer", async () => {
      const failure = await db
        .transaction(["users", "tags"], async (tx) => {
          await tx.users.create({ id: "u1", name: "Alice" });
          await sleep(20);
          await tx.tags.create({ id: "t1", label: "late" });
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IdbTransactionCommittedEarlyError);
      const { cause } = failure as IdbTransactionCommittedEarlyError;
      expect(cause).toBeInstanceOf(IdbExecuteError);
      expect((cause as IdbExecuteError).code).toBe("TRANSACTION_INACTIVE");
      expect(await userIds()).toEqual(["u1"]);
    });

    it("reports that writes were committed when the callback throws after an awaited timer", async () => {
      const original = new Error("after the timer");

      const failure = await db
        .transaction(["users"], async (tx) => {
          await tx.users.create({ id: "u1", name: "Alice" });
          await sleep(20);
          throw original;
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IdbTransactionCommittedEarlyError);
      expect((failure as IdbTransactionCommittedEarlyError).cause).toBe(original);
      expect(await userIds()).toEqual(["u1"]);
    });
  });

  describe("nesting", () => {
    it("ends the outer transaction early when the callback awaits an inner db.transaction()", async () => {
      const failure = await db
        .transaction(["users"], async (outer) => {
          await outer.users.create({ id: "u1", name: "Alice" });
          await db.transaction(["users"], (inner) => inner.users.create({ id: "u2", name: "Bob" }));
          await outer.users.create({ id: "u3", name: "Carol" });
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IdbTransactionCommittedEarlyError);
    });
  });

  describe("lifetime and typing", () => {
    it("rejects use of tx after the callback has finished", async () => {
      const leaked = await db.transaction(["users"], async (tx) => tx);

      await expect(leaked.users.create({ id: "u1", name: "Alice" })).rejects.toThrow(/transaction has ended/);
      expect(await userIds()).toEqual([]);
    });

    it("exposes only the listed models", async () => {
      await db.transaction(["users"], async (tx) => {
        expect(Object.keys(tx)).toEqual(["users"]);
      });
    });

    it("rejects an unknown root key", async () => {
      await expect(db.transaction(["nope"], async () => undefined)).rejects.toThrow(/nope/);
    });

    it("rejects an empty model list", async () => {
      await expect(db.transaction([], async () => undefined)).rejects.toThrow(/at least one model/);
    });
  });
});

describe("OpenTransaction", () => {
  const meta = { target: "idb", storageHash: "test", lane: "test" } as const;

  it("names the stores an operation needs that the transaction did not open, and aborts", async () => {
    const scope: IdbTransactionScope = { execute: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    const open = new OpenTransaction(scope, ["users"], meta);

    await expect(open.execute({ meta, kind: "key-get", storeName: "posts", key: "p1" })).rejects.toThrow(
      /Stores "posts" are not part of this transaction/
    );

    expect(scope.execute).not.toHaveBeenCalled();
    expect(scope.rollback).toHaveBeenCalledOnce();
  });

  it("aborts when a view of the transaction asks for stores it did not open", async () => {
    const scope: IdbTransactionScope = { execute: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    const open = new OpenTransaction(scope, ["users"], meta);

    await expect(open.transaction(["users", "posts"])).rejects.toThrow(
      /Stores "posts" are not part of this transaction/
    );

    expect(scope.rollback).toHaveBeenCalledOnce();
  });
});
