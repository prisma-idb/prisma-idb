/**
 * Phase 6.8 — FK referential action enforcement on delete.
 *
 * Covers:
 *   restrict (default) — throws when children exist; succeeds when none
 *   cascade           — deletes children in the same transaction
 *   setNull           — nulls child FK fields in the same transaction
 *   noAction          — behaves like restrict, as NO ACTION does in SQL
 *   setDefault        — throws (unsupported)
 *   deleteAll cascade — cascade propagates for every deleted parent
 *   deleteCount       — inherits enforcement from deleteAll
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

/** Untyped view of an accessor, for fixtures whose rows aren't worth typing. */
type LooseAccessor = {
  create(d: Record<string, unknown>): Promise<unknown>;
  createAll(d: Record<string, unknown>[]): { toArray(): Promise<unknown[]> };
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  where(w: Record<string, unknown>): { update(p: Record<string, unknown>): Promise<unknown> };
  updateAll(p: Record<string, unknown>): { toArray(): Promise<unknown[]> };
};

// ── Test executor ─────────────────────────────────────────────────────────────

class TestExecutorWithTransaction implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
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

/** A bare executor with no `.transaction()` — verifies `upsert()` rejects when transaction support is absent. */
class BareTestExecutor implements IdbQueryExecutor {
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
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let dbCounter = 0;
function nextDbName(): string {
  return `fk-enforcement-test-${++dbCounter}`;
}

function openTestDb(name: string): Promise<IDBDatabase> {
  return openTestDbWithStores(name, { users: "id", posts: "id" });
}

/** Like {@link openTestDb}, but with an arbitrary set of stores (name → keyPath). Used by multi-hop/self-referential fixtures. */
function openTestDbWithStores(name: string, stores: Record<string, string | string[]>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [storeName, keyPath] of Object.entries(stores)) {
        db.createObjectStore(storeName, { keyPath });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllRows(db: IDBDatabase, storeName: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
    req.onerror = () => reject(req.error);
  });
}

// ── restrict (default) ────────────────────────────────────────────────────────

const restrictContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
        // no onDelete → defaults to restrict
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String" },
    },
  },
});

describe("delete — restrict (default)", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("throws when child records exist", async () => {
    const orm = idbOrm({ contract: restrictContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await expect(orm["users"]!.delete("u1" as never)).rejects.toThrow(/Cannot delete User.*child records.*posts/i);
    // Parent and child must both still exist (transaction rolled back).
    expect(await getAllRows(db, "users")).toHaveLength(1);
    expect(await getAllRows(db, "posts")).toHaveLength(1);
  });

  it("succeeds when no child records exist", async () => {
    const orm = idbOrm({ contract: restrictContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.delete("u1" as never);
    expect(await getAllRows(db, "users")).toHaveLength(0);
  });
});

// ── cascade ───────────────────────────────────────────────────────────────────

const cascadeContract = defineContract({
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
    },
  },
});

const fkSideCascadeContract = defineContract({
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
      fields: { id: "String", authorId: "String", title: "String" },
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
});

describe("delete — cascade", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("deletes parent and all children in the same transaction", async () => {
    const orm = idbOrm({ contract: cascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post 1", authorId: "u1" } as never);
    await orm["posts"]!.create({ id: "p2", title: "Post 2", authorId: "u1" } as never);
    await orm["users"]!.delete("u1" as never);
    expect(await getAllRows(db, "users")).toHaveLength(0);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });

  it("only deletes children belonging to the deleted parent", async () => {
    const orm = idbOrm({ contract: cascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Alice post", authorId: "u1" } as never);
    await orm["posts"]!.create({ id: "p2", title: "Bob post", authorId: "u2" } as never);
    await orm["users"]!.delete("u1" as never);
    expect(await getAllRows(db, "users")).toHaveLength(1);
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["id"]).toBe("p2");
  });

  it("delete of nonexistent key is a no-op", async () => {
    const orm = idbOrm({ contract: cascadeContract, executor });
    await orm["users"]!.delete("ghost" as never);
    expect(await getAllRows(db, "users")).toHaveLength(0);
  });

  it("honors onDelete stored on the FK-side relation", async () => {
    const orm = idbOrm({ contract: fkSideCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);

    await orm["users"]!.delete("u1" as never);

    expect(await getAllRows(db, "users")).toHaveLength(0);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });
});

// ── setNull ───────────────────────────────────────────────────────────────────

const setNullContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "setNull" },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String?", title: "String" },
    },
  },
});

describe("delete — setNull", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("nulls FK on children and deletes parent", async () => {
    const orm = idbOrm({ contract: setNullContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await orm["users"]!.delete("u1" as never);
    expect(await getAllRows(db, "users")).toHaveLength(0);
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["authorId"]).toBeNull();
  });
});

// ── noAction ──────────────────────────────────────────────────────────────────

const noActionContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "noAction" },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String" },
    },
  },
});

describe("delete — noAction", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  // Postgres rejects this delete for the same schema (NO ACTION only defers
  // the check), so the client must too, or a synced app diverges.
  it("behaves like restrict: refuses to delete a parent that has children", async () => {
    const orm = idbOrm({ contract: noActionContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await expect(orm["users"]!.delete("u1" as never)).rejects.toThrow(/child records exist/);
    expect(await getAllRows(db, "users")).toHaveLength(1);
    expect(await getAllRows(db, "posts")).toHaveLength(1);
  });
});

// ── setDefault ───────────────────────────────────────────────────────────────

const setDefaultContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["id"], target: ["authorId"] },
          onDelete: "setDefault",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String" },
      fieldDefaults: { authorId: "system" },
    },
  },
});

const setDefaultNoDefaultContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["id"], target: ["authorId"] },
          onDelete: "setDefault",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String" },
      // no fieldDefaults declared for authorId
    },
  },
});

describe("delete — setDefault", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("resets child FK fields to their declared literal default and deletes parent", async () => {
    const orm = idbOrm({ contract: setDefaultContract, executor });
    // The default value must reference a real row — same as SQL's `ON DELETE
    // SET DEFAULT` only being safe because the FK constraint re-checks the
    // new value transactionally. A "system" sentinel row is required here.
    await orm["users"]!.create({ id: "system", name: "System" } as never);
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await orm["users"]!.delete("u1" as never);
    expect(await getAllRows(db, "users")).toHaveLength(1);
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["authorId"]).toBe("system");
  });

  it("throws when the default value does not reference an existing row", async () => {
    const orm = idbOrm({ contract: setDefaultContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    // No "system" user exists — the delete must be rejected, not silently
    // write a dangling authorId.
    await expect(orm["users"]!.delete("u1" as never)).rejects.toThrow(/does not reference a real row/i);
    expect(await getAllRows(db, "users")).toHaveLength(1);
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["authorId"]).toBe("u1");
  });

  it("throws when the target field has no declared default", async () => {
    const orm = idbOrm({ contract: setDefaultNoDefaultContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await expect(orm["users"]!.delete("u1" as never)).rejects.toThrow(/no default is registered/i);
  });
});

// ── scalar FK validation — compound (multi-field) ──────────────────────────────

const compoundFkContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", orgId: "String", name: "String" },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", postOrgId: "String", authorId: "String", title: "String" },
      relations: {
        author: {
          to: "User",
          cardinality: "N:1",
          on: { local: ["postOrgId", "authorId"], target: ["orgId", "id"] },
        },
      },
    },
  },
});

// Users are keyed by a compound primary key declared as [orgId, id]; the
// relation lists the same fields in the other order, so the key-only lookup
// has to reorder the values into key order.
const compoundPkParentContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: ["orgId", "id"], fields: { orgId: "String", id: "String", name: "String" } },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", authorOrgId: "String", title: "String" },
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId", "authorOrgId"], target: ["id", "orgId"] } },
      },
    },
  },
});

describe("scalar FK validation — compound (multi-field)", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;
  let orm: Record<string, LooseAccessor>;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
    orm = idbOrm({ contract: compoundFkContract, executor }) as unknown as Record<string, LooseAccessor>;
    await orm["users"]!.create({ id: "u1", orgId: "org-A", name: "Alice" });
    await orm["users"]!.create({ id: "u2", orgId: "org-B", name: "Bob" });
  });
  afterEach(() => db.close());

  it("accepts a create whose whole tuple matches one parent", async () => {
    await orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u1", title: "Post" });
    expect(await getAllRows(db, "posts")).toHaveLength(1);
  });

  // Each value matches *some* User (org-A is u1's, u2 is Bob), but no single
  // User has both. Checking the fields one at a time would let this through.
  it("rejects a tuple assembled from two different parents", async () => {
    await expect(orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u2", title: "Post" })).rejects.toThrow(
      /FK violation on relation 'author': no User with orgId='org-A', id='u2'/
    );
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });

  it("doesn't check a tuple with a null field, like SQL's MATCH SIMPLE", async () => {
    await orm["posts"]!.create({ id: "p1", postOrgId: null, authorId: "nobody", title: "Post" });
    expect(await getAllRows(db, "posts")).toHaveLength(1);
  });

  it("update: checks a partly-set key against the row's other key field", async () => {
    await orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u1", title: "Post" });
    // p1 stays in org-A, and u2 isn't in org-A.
    await expect(orm["posts"]!.where({ id: "p1" }).update({ authorId: "u2" })).rejects.toThrow(/FK violation/);
    expect((await getAllRows(db, "posts"))[0]?.["authorId"]).toBe("u1");
    // Moving both fields together is fine.
    await orm["posts"]!.where({ id: "p1" }).update({ authorId: "u2", postOrgId: "org-B" });
    expect((await getAllRows(db, "posts"))[0]?.["authorId"]).toBe("u2");
  });

  it("updateAll: checks each row's tuple and writes nothing if one fails", async () => {
    await orm["users"]!.create({ id: "u3", orgId: "org-A", name: "Carol" });
    await orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u1", title: "A" });
    await orm["posts"]!.create({ id: "p2", postOrgId: "org-B", authorId: "u2", title: "B" });
    // u3 is in org-A: fine for p1, a violation for p2.
    await expect(orm["posts"]!.updateAll({ authorId: "u3" }).toArray()).rejects.toThrow(/FK violation/);
    expect((await getAllRows(db, "posts")).map((p) => p["authorId"]).sort()).toEqual(["u1", "u2"]);
  });

  it("uses a key-only lookup for a compound primary key declared in a different order", async () => {
    const name = nextDbName();
    const keyedDb = await openTestDbWithStores(name, { users: ["orgId", "id"], posts: "id" });
    const keyedExecutor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
    const keyed = idbOrm({ contract: compoundPkParentContract, executor: keyedExecutor }) as unknown as Record<
      string,
      LooseAccessor
    >;
    try {
      await keyed["users"]!.create({ orgId: "org-A", id: "u1", name: "Alice" });
      await keyed["posts"]!.create({ id: "p1", authorId: "u1", authorOrgId: "org-A", title: "ok" });
      await expect(
        keyed["posts"]!.create({ id: "p2", authorId: "u1", authorOrgId: "org-B", title: "bad" })
      ).rejects.toThrow(/FK violation/);
      expect(await getAllRows(keyedDb, "posts")).toHaveLength(1);
    } finally {
      keyedDb.close();
    }
  });
});

const compoundSetDefaultContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", orgId: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["orgId", "id"], target: ["postOrgId", "authorId"] },
          onDelete: "setDefault",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", postOrgId: "String", authorId: "String", title: "String" },
      fieldDefaults: { postOrgId: "org-S", authorId: "system" },
    },
  },
});

describe("delete — setDefault on a compound relation", () => {
  let db: IDBDatabase;
  let orm: Record<string, LooseAccessor & { delete(k: unknown): Promise<unknown> }>;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    const executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
    orm = idbOrm({ contract: compoundSetDefaultContract, executor }) as unknown as typeof orm;
    await orm["users"]!.create({ id: "u1", orgId: "org-A", name: "Alice" });
    await orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u1", title: "Post" });
  });
  afterEach(() => db.close());

  it("re-points children at the default tuple when one parent matches all of it", async () => {
    await orm["users"]!.create({ id: "system", orgId: "org-S", name: "System" });
    await orm["users"]!.delete("u1");
    const post = (await getAllRows(db, "posts"))[0];
    expect([post?.["postOrgId"], post?.["authorId"]]).toEqual(["org-S", "system"]);
  });

  it("refuses when the default tuple matches no single parent", async () => {
    // A "system" user exists, but in the wrong org.
    await orm["users"]!.create({ id: "system", orgId: "org-X", name: "System" });
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/does not reference a real row/);
    expect(await getAllRows(db, "users")).toHaveLength(2);
  });
});

describe("scalar FK validation — createAll and upsert", () => {
  let db: IDBDatabase;
  let orm: Record<string, LooseAccessor>;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    const executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
    orm = idbOrm({ contract: compoundFkContract, executor }) as unknown as Record<string, LooseAccessor>;
    await orm["users"]!.create({ id: "u1", orgId: "org-A", name: "Alice" });
  });
  afterEach(() => db.close());

  it("createAll checks every row and writes none if one fails", async () => {
    const rows = [
      { id: "p1", postOrgId: "org-A", authorId: "u1", title: "ok" },
      { id: "p2", postOrgId: "org-A", authorId: "ghost", title: "bad" },
    ];
    await expect(orm["posts"]!.createAll(rows).toArray()).rejects.toThrow(/FK violation/);
    expect(await getAllRows(db, "posts")).toHaveLength(0);

    expect(await orm["posts"]!.createAll(rows.slice(0, 1)).toArray()).toHaveLength(1);
  });

  it("upsert checks the create branch", async () => {
    await expect(
      orm["posts"]!.upsert({
        where: { id: "p1" },
        create: { id: "p1", postOrgId: "org-A", authorId: "ghost", title: "bad" },
        update: {},
      })
    ).rejects.toThrow(/FK violation/);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });

  it("upsert checks the update branch, using the existing row for a partly-set key", async () => {
    await orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u1", title: "ok" });
    await expect(
      orm["posts"]!.upsert({
        where: { id: "p1" },
        create: { id: "p1", postOrgId: "org-A", authorId: "u1", title: "ok" },
        update: { authorId: "ghost" },
      })
    ).rejects.toThrow(/FK violation/);
    expect((await getAllRows(db, "posts"))[0]?.["authorId"]).toBe("u1");
  });
});

// ── deleteAll with cascade ────────────────────────────────────────────────────

describe("deleteAll — cascade", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascade-deletes children for every deleted parent", async () => {
    const orm = idbOrm({ contract: cascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", title: "A post", authorId: "u1" } as never);
    await orm["posts"]!.create({ id: "p2", title: "B post", authorId: "u2" } as never);
    const deleted = await orm["users"]!.deleteAll().toArray();
    expect(deleted).toHaveLength(2);
    expect(await getAllRows(db, "users")).toHaveLength(0);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });

  it("deleteAll with a where filter only deletes matching parents and their children", async () => {
    const orm = idbOrm({ contract: cascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", title: "A post", authorId: "u1" } as never);
    await orm["posts"]!.create({ id: "p2", title: "B post", authorId: "u2" } as never);
    await orm["users"]!.where({ id: "u1" } as never)
      .deleteAll()
      .toArray();
    expect(await getAllRows(db, "users")).toHaveLength(1);
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["id"]).toBe("p2");
  });
});

// ── deleteCount with cascade ──────────────────────────────────────────────────

describe("deleteCount — cascade", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDb(name);
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("returns the count of deleted parents and cascades children", async () => {
    const orm = idbOrm({ contract: cascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    const count = await orm["users"]!.deleteCount();
    expect(count).toBe(2);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });
});

// ── recursive (multi-hop) cascade ──────────────────────────────────────────────

const multiHopCascadeContract = defineContract({
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
        comments: {
          to: "Comment",
          cardinality: "1:N",
          on: { local: ["id"], target: ["postId"] },
          onDelete: "cascade",
        },
      },
    },
    Comment: {
      store: "comments",
      key: "id",
      fields: { id: "String", postId: "String", text: "String" },
    },
  },
});

describe("delete — recursive cascade (multi-hop)", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id", comments: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascades through a User -> Post -> Comment chain", async () => {
    const orm = idbOrm({ contract: multiHopCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await orm["comments"]!.create({ id: "c1", text: "Comment", postId: "p1" } as never);

    await orm["users"]!.delete("u1" as never);

    expect(await getAllRows(db, "users")).toHaveLength(0);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
    expect(await getAllRows(db, "comments")).toHaveLength(0);
  });
});

const cascadeStopsAtLeafContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "setNull" },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String?", title: "String" },
      relations: {
        comments: {
          to: "Comment",
          cardinality: "1:N",
          on: { local: ["id"], target: ["postId"] },
          onDelete: "cascade",
        },
      },
    },
    Comment: {
      store: "comments",
      key: "id",
      fields: { id: "String", postId: "String", text: "String" },
    },
  },
});

describe("delete — cascade stops at a setNull/setDefault leaf", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id", comments: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("does not cascade into a setNull child's own children, since that child row survives", async () => {
    const orm = idbOrm({ contract: cascadeStopsAtLeafContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await orm["comments"]!.create({ id: "c1", text: "Comment", postId: "p1" } as never);

    await orm["users"]!.delete("u1" as never);

    expect(await getAllRows(db, "users")).toHaveLength(0);
    const posts = await getAllRows(db, "posts");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.["authorId"]).toBeNull();
    // Post survived (only nulled), so its own cascade to Comment never fires.
    expect(await getAllRows(db, "comments")).toHaveLength(1);
  });
});

const cascadeRestrictInteractionContract = defineContract({
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
        // no onDelete → defaults to restrict
        comments: { to: "Comment", cardinality: "1:N", on: { local: ["id"], target: ["postId"] } },
      },
    },
    Comment: {
      store: "comments",
      key: "id",
      fields: { id: "String", postId: "String", text: "String" },
    },
  },
});

describe("delete — cascade + restrict interaction across hops", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id", comments: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("a restrict two hops down aborts the whole delete and rolls back every hop", async () => {
    const orm = idbOrm({ contract: cascadeRestrictInteractionContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);
    await orm["comments"]!.create({ id: "c1", text: "Comment", postId: "p1" } as never);

    await expect(orm["users"]!.delete("u1" as never)).rejects.toThrow(/Cannot delete Post.*comments/i);

    expect(await getAllRows(db, "users")).toHaveLength(1);
    expect(await getAllRows(db, "posts")).toHaveLength(1);
    expect(await getAllRows(db, "comments")).toHaveLength(1);
  });
});

const selfReferentialCascadeContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Employee: {
      store: "employees",
      key: "id",
      fields: { id: "String", managerId: "String?", name: "String" },
      relations: {
        reports: {
          to: "Employee",
          cardinality: "1:N",
          on: { local: ["id"], target: ["managerId"] },
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      },
    },
  },
});

describe("delete — cascade on a self-referential model", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { employees: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascades down a multi-level management chain", async () => {
    const orm = idbOrm({ contract: selfReferentialCascadeContract, executor });
    await orm["employees"]!.create({ id: "root", managerId: null, name: "Root" } as never);
    await orm["employees"]!.create({ id: "a", managerId: "root", name: "A" } as never);
    await orm["employees"]!.create({ id: "b", managerId: "a", name: "B" } as never);
    await orm["employees"]!.create({ id: "c", managerId: "b", name: "C" } as never);

    await orm["employees"]!.delete("root" as never);

    expect(await getAllRows(db, "employees")).toHaveLength(0);
  });

  it("terminates on a mutual-reference cycle instead of hanging or stack-overflowing", async () => {
    const orm = idbOrm({ contract: selfReferentialCascadeContract, executor });
    // x and y point at each other through the same self-relation.
    await orm["employees"]!.create({ id: "x", managerId: "y", name: "X" } as never);
    await orm["employees"]!.create({ id: "y", managerId: "x", name: "Y" } as never);

    await orm["employees"]!.delete("x" as never);

    expect(await getAllRows(db, "employees")).toHaveLength(0);
  });
});

describe("deleteAll — recursive cascade with multiple independent trees", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id", comments: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascades each independent tree fully — the visited set must not be shared across top-level rows", async () => {
    const orm = idbOrm({ contract: multiHopCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post 1", authorId: "u1" } as never);
    await orm["posts"]!.create({ id: "p2", title: "Post 2", authorId: "u2" } as never);
    await orm["comments"]!.create({ id: "c1", text: "Comment 1", postId: "p1" } as never);
    await orm["comments"]!.create({ id: "c2", text: "Comment 2", postId: "p2" } as never);

    const deleted = await orm["users"]!.deleteAll().toArray();

    expect(deleted).toHaveLength(2);
    expect(await getAllRows(db, "users")).toHaveLength(0);
    expect(await getAllRows(db, "posts")).toHaveLength(0);
    expect(await getAllRows(db, "comments")).toHaveLength(0);
  });
});

// ── onUpdate ─────────────────────────────────────────────────────────────────
//
// Relations below target a non-key unique field (`slug`), not the model's
// own `@id` — IDB derives an object store's key from `keyPath` at `put()`
// time, so patching the `@id` field itself would silently insert a second
// record under the new key instead of renaming the existing one (a
// pre-existing IDB quirk, unrelated to onUpdate enforcement, out of scope
// here). Every fixture below sidesteps it by relating on `slug` instead.

const onUpdateCascadeContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["slug"], target: ["authorSlug"] },
          onUpdate: "cascade",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorSlug: "String", title: "String" },
    },
  },
});

describe("onUpdate — cascade", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("propagates a changed referenced value to children", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice2");
  });

  it("is a no-op when the patch sets the field to its existing value", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice");
  });

  it("is a no-op when the patch only touches an unrelated field", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ name: "Alicia" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice");
    const users = await getAllRows(db, "users");
    expect(users[0]?.["name"]).toBe("Alicia");
  });
});

const onUpdateSetNullContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["slug"], target: ["authorSlug"] },
          onUpdate: "setNull",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorSlug: "String?", title: "String" },
    },
  },
});

describe("onUpdate — setNull", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("nulls the child FK field instead of propagating the new value", async () => {
    const orm = idbOrm({ contract: onUpdateSetNullContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBeNull();
  });
});

const onUpdateSetDefaultContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["slug"], target: ["authorSlug"] },
          onUpdate: "setDefault",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorSlug: "String", title: "String" },
      fieldDefaults: { authorSlug: "system" },
    },
  },
});

describe("onUpdate — setDefault", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("resets the child FK field to its declared literal default", async () => {
    const orm = idbOrm({ contract: onUpdateSetDefaultContract, executor });
    // The default must reference a real row — see the equivalent onDelete test.
    await orm["users"]!.create({ id: "system", slug: "system", name: "System" } as never);
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("system");
  });

  it("throws when the default value does not reference an existing row, rolling back the update", async () => {
    const orm = idbOrm({ contract: onUpdateSetDefaultContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await expect(orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never)).rejects.toThrow(
      /does not reference a real row/i
    );

    const users = await getAllRows(db, "users");
    expect(users[0]?.["slug"]).toBe("alice");
    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice");
  });

  // Regression test: the row being updated is still present in the store
  // (with its *old* slug) when `validateSetDefaultPatch` scans for a real
  // row matching the default — without excluding that row's own key, the
  // scan would find the row about to change away from "system" and wrongly
  // treat the default as valid.
  it("does not accept the row's own pre-change value as satisfying the default", async () => {
    const orm = idbOrm({ contract: onUpdateSetDefaultContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "system", name: "Coincidence" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await expect(orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never)).rejects.toThrow(
      /does not reference a real row/i
    );
  });
});

const onUpdateRestrictContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["slug"], target: ["authorSlug"] },
          onUpdate: "restrict",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorSlug: "String", title: "String" },
    },
  },
});

describe("onUpdate — restrict", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("aborts the update when child records exist and rolls back", async () => {
    const orm = idbOrm({ contract: onUpdateRestrictContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await expect(orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never)).rejects.toThrow(
      /Cannot update User.*orphan child records.*posts/i
    );

    const users = await getAllRows(db, "users");
    expect(users[0]?.["slug"]).toBe("alice");
    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice");
  });

  it("succeeds when no child records exist", async () => {
    const orm = idbOrm({ contract: onUpdateRestrictContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never);

    const users = await getAllRows(db, "users");
    expect(users[0]?.["slug"]).toBe("alice2");
  });
});

const onUpdateNoActionContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["slug"], target: ["authorSlug"] },
          onUpdate: "noAction",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorSlug: "String", title: "String" },
    },
  },
});

describe("onUpdate — noAction", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("behaves like restrict: refuses to change a value children refer to", async () => {
    const orm = idbOrm({ contract: onUpdateNoActionContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await expect(orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never)).rejects.toThrow(
      /would orphan child records/
    );

    expect((await getAllRows(db, "users"))[0]?.["slug"]).toBe("alice");
    expect((await getAllRows(db, "posts"))[0]?.["authorSlug"]).toBe("alice");
  });

  // Prisma 8 emits no ON UPDATE clause for an undeclared action, so Postgres
  // uses NO ACTION. The client's default must match.
  it("an undeclared onUpdate defaults to restrict", async () => {
    const undeclared = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", slug: "String", name: "String" },
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["slug"], target: ["authorSlug"] } } },
        },
        Post: { store: "posts", key: "id", fields: { id: "String", authorSlug: "String", title: "String" } },
      },
    });
    const orm = idbOrm({ contract: undeclared, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await expect(orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never)).rejects.toThrow(
      /would orphan child records/
    );
    // Changing a field no child refers to is still allowed.
    await orm["users"]!.where({ id: "u1" } as never).update({ name: "Alicia" } as never);
    expect((await getAllRows(db, "users"))[0]?.["name"]).toBe("Alicia");
  });
});

describe("onUpdate — updateAll / updateCount bulk", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascades to each matched row's own children in one updateAll call", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["users"]!.create({ id: "u2", slug: "bob", name: "Bob" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post 1" } as never);
    await orm["posts"]!.create({ id: "p2", authorSlug: "bob", title: "Post 2" } as never);

    const updated = await orm["users"]!.updateAll({ slug: "merged" } as never).toArray();

    expect(updated).toHaveLength(2);
    const posts = await getAllRows(db, "posts");
    expect(posts.map((p) => p["authorSlug"]).sort()).toEqual(["merged", "merged"]);
  });

  it("updateCount returns the count of updated rows and still cascades", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post 1" } as never);

    const count = await orm["users"]!.updateCount({ slug: "changed" } as never);

    expect(count).toBe(1);
    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("changed");
  });
});

describe("onUpdate — upsert update arm", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascades when the update arm changes a referenced field", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);

    await orm["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", slug: "alice", name: "Alice" },
      update: { slug: "alice2" },
    } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice2");
  });

  it("the create arm (no existing row) is unaffected by the onUpdate store-list union", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });

    const created = await orm["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", slug: "alice", name: "Alice" },
      update: { slug: "alice2" },
    } as never);

    expect(created).toMatchObject({ id: "u1", slug: "alice", name: "Alice" });
  });
});

describe("onUpdate — parity between update() and upsert()'s update arm", () => {
  it("produce the same cascade result for identical input", async () => {
    const nameA = nextDbName();
    const dbA = await openTestDbWithStores(nameA, { users: "id", posts: "id" });
    const executorA = new TestExecutorWithTransaction(createIDBRuntimeDriver(nameA).create());
    const ormA = idbOrm({ contract: onUpdateCascadeContract, executor: executorA });
    await ormA["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await ormA["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);
    await ormA["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never);

    const nameB = nextDbName();
    const dbB = await openTestDbWithStores(nameB, { users: "id", posts: "id" });
    const executorB = new TestExecutorWithTransaction(createIDBRuntimeDriver(nameB).create());
    const ormB = idbOrm({ contract: onUpdateCascadeContract, executor: executorB });
    await ormB["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await ormB["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);
    await ormB["users"]!.upsert({
      where: { id: "u1" },
      create: { id: "u1", slug: "alice", name: "Alice" },
      update: { slug: "alice2" },
    } as never);

    const postsA = await getAllRows(dbA, "posts");
    const postsB = await getAllRows(dbB, "posts");
    expect(postsA[0]?.["authorSlug"]).toBe(postsB[0]?.["authorSlug"]);

    dbA.close();
    dbB.close();
  });
});

const onUpdateCompoundContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", orgId: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["orgId", "id"], target: ["postOrgId", "authorId"] },
          onUpdate: "cascade",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", postOrgId: "String", authorId: "String", title: "String" },
    },
  },
});

describe("onUpdate — compound (multi-field) relation cascade", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("succeeds — unlike scalar-FK compound validation, both fields come from the same row so there's no cross-row ambiguity", async () => {
    const orm = idbOrm({ contract: onUpdateCompoundContract, executor });
    await orm["users"]!.create({ id: "u1", orgId: "org-A", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", postOrgId: "org-A", authorId: "u1", title: "Post" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ orgId: "org-B" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["postOrgId"]).toBe("org-B");
    // The untouched half of the compound key is left alone.
    expect(posts[0]?.["authorId"]).toBe("u1");
  });
});

const onUpdateMultiHopContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", slug: "String", name: "String" },
      relations: {
        posts: {
          to: "Post",
          cardinality: "1:N",
          on: { local: ["slug"], target: ["authorSlug"] },
          onUpdate: "cascade",
        },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorSlug: "String", title: "String" },
      relations: {
        comments: {
          to: "Comment",
          cardinality: "1:N",
          on: { local: ["authorSlug"], target: ["postAuthorSlug"] },
          onUpdate: "cascade",
        },
      },
    },
    Comment: {
      store: "comments",
      key: "id",
      fields: { id: "String", postAuthorSlug: "String", text: "String" },
    },
  },
});

describe("onUpdate — multi-hop cascade (User -> Post -> Comment)", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id", comments: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("propagates a changed value through two hops when the same field chains two relations", async () => {
    const orm = idbOrm({ contract: onUpdateMultiHopContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", authorSlug: "alice", title: "Post" } as never);
    await orm["comments"]!.create({ id: "c1", postAuthorSlug: "alice", text: "hi" } as never);

    await orm["users"]!.where({ id: "u1" } as never).update({ slug: "alice2" } as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorSlug"]).toBe("alice2");
    const comments = await getAllRows(db, "comments");
    expect(comments[0]?.["postAuthorSlug"]).toBe("alice2");
  });
});

describe("onUpdate — cascade on a self-referential model", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { employees: "id" });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  // Regression test: `collectOnUpdateEnforcementStoreNames`'s related store
  // for a self-referential relation is the model's own store — already the
  // seed of its result set — so `storeNames.length` alone can't distinguish
  // "no enforcement applies" from "enforcement applies, but only within this
  // one store". `update()` must still take the read-before-write enforcement
  // path here, not the fast blind-write path (which would skip the cascade
  // below entirely).
  it("propagates a changed referenced field onto self-referential children", async () => {
    const orm = idbOrm({ contract: selfReferentialCascadeContract, executor });
    await orm["employees"]!.create({ id: "root", managerId: null, name: "Root" } as never);
    await orm["employees"]!.create({ id: "a", managerId: "root", name: "A" } as never);

    await orm["employees"]!.where({ id: "root" } as never).update({ id: "root2" } as never);

    const employees = await getAllRows(db, "employees");
    const a = employees.find((e) => e["id"] === "a");
    expect(a?.["managerId"]).toBe("root2");
  });
});

describe("upsert — requires a transaction-capable executor", () => {
  let db: IDBDatabase;
  let executor: BareTestExecutor;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { users: "id", posts: "id" });
    executor = new BareTestExecutor(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  // upsert() used to keep a non-atomic two-step fallback for a bare
  // executor (no `.transaction()`), which could silently skip onUpdate
  // referential-action enforcement. That fallback is gone: upsert() now
  // requires transaction support unconditionally, matching
  // create/update/delete/updateAll/deleteAll.
  it("rejects unconditionally on a bare executor, regardless of the patch", async () => {
    const orm = idbOrm({ contract: onUpdateCascadeContract, executor });
    await orm["users"]!.create({ id: "u1", slug: "alice", name: "Alice" } as never);

    await expect(
      orm["users"]!.upsert({
        where: { id: "u1" },
        create: { id: "u1", slug: "alice", name: "Alice" },
        update: { name: "Alicia" },
      } as never)
    ).rejects.toThrow(/requires an executor with transaction support/i);
  });
});
