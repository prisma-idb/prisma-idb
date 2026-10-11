/**
 * Existence checks inside mutations: FK validation, `setDefault` validation
 * and `restrict`.
 *
 * Covers lookups on a primary key, on a non-key field, on one member of a
 * compound key, on values that aren't valid IndexedDB keys (NaN), and on a Date
 * that equals the stored one by value but not by reference. Which physical plan
 * runs is pinned by `plan-shape-gate.test.ts`, not here.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbRuntimeDriverInstance, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm, IdbRecordValidationError } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

// ── Executor ──────────────────────────────────────────────────────────────────

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
  transaction(storeNames: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope> {
    return this.#driver.transaction(storeNames, mode);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let dbCounter = 0;
const nextDbName = () => `existence-checks-test-${++dbCounter}`;

function openTestDbWithStores(name: string, stores: Record<string, string | string[]>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const [storeName, keyPath] of Object.entries(stores)) req.result.createObjectStore(storeName, { keyPath });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllRows(db: IDBDatabase, storeName: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction([storeName], "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
    req.onerror = () => reject(req.error);
  });
}

/** Opens a fresh DB with `stores`, and returns an ORM + the raw db. */
async function setup(contract: ReturnType<typeof defineContract>, stores: Record<string, string | string[]>) {
  const name = nextDbName();
  const db = await openTestDbWithStores(name, stores);
  const executor = new TestExecutor(createIDBRuntimeDriver(name).create());
  const orm = idbOrm({ contract, executor }) as unknown as Record<
    string,
    {
      create(d: unknown): Promise<unknown>;
      delete(k: unknown): Promise<unknown>;
      where(f: unknown): { update(p: unknown): Promise<unknown> };
    }
  >;
  return { db, orm };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const userPostContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String?", title: "String" },
      relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
    },
  },
});

// ── validateScalarFks: FK → primary key ───────────────────────────────────────

describe("FK validation — target is the parent's primary key", () => {
  let db: IDBDatabase;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, orm } = await setup(userPostContract, { users: "id", posts: "id" }));
    await orm["users"]!.create({ id: "u1", name: "Alice" });
  });
  afterEach(() => db.close());

  it("accepts an FK to an existing parent", async () => {
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" });
    expect(await getAllRows(db, "posts")).toHaveLength(1);
  });

  it("rejects a missing parent with the unchanged FK-violation message", async () => {
    await expect(orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "ghost" })).rejects.toThrow(
      /FK violation on relation 'author': no User with id='ghost'/
    );
    expect(await getAllRows(db, "posts")).toHaveLength(0);
  });

  it("rejects a missing parent on update", async () => {
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" });
    await expect(orm["posts"]!.where({ id: "p1" }).update({ authorId: "ghost" })).rejects.toThrow(/FK violation/);
  });

  it("accepts a null FK", async () => {
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: null });
    expect(await getAllRows(db, "posts")).toHaveLength(1);
  });
});

// ── DateTime-keyed parent: JS `===` vs IDB key equality ────────────────────────

describe("FK validation — Date-keyed parent", () => {
  const dateContract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Period: {
        store: "periods",
        key: "startsAt",
        fields: { startsAt: "DateTime", label: "String" },
        relations: {
          entries: { to: "Entry", cardinality: "1:N", on: { local: ["startsAt"], target: ["periodStart"] } },
        },
      },
      Entry: {
        store: "entries",
        key: "id",
        fields: { id: "String", periodStart: "DateTime" },
        relations: {
          period: { to: "Period", cardinality: "N:1", on: { local: ["periodStart"], target: ["startsAt"] } },
        },
      },
    },
  });

  let db: IDBDatabase;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, orm } = await setup(dateContract, { periods: "startsAt", entries: "id" }));
    await orm["periods"]!.create({ startsAt: new Date("2026-01-01T00:00:00Z"), label: "Jan" });
  });
  afterEach(() => db.close());

  it("accepts an FK equal BY VALUE to an existing parent's Date key", async () => {
    // Two distinct-but-equal Date objects: JS `===` is false, IDB key equality is true.
    await orm["entries"]!.create({ id: "e1", periodStart: new Date("2026-01-01T00:00:00Z") });
    expect(await getAllRows(db, "entries")).toHaveLength(1);
  });

  it("still rejects a Date that matches no parent", async () => {
    await expect(orm["entries"]!.create({ id: "e1", periodStart: new Date("2027-01-01T00:00:00Z") })).rejects.toThrow(
      /FK violation on relation 'period'/
    );
  });
});

// ── Lookups that aren't a primary-key match ───────────────────────────────────

describe("FK validation — target isn't exactly the parent's primary key", () => {
  it("target field is NOT the parent's primary key", async () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", email: "String" },
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["email"], target: ["authorEmail"] } } },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorEmail: "String" },
          relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorEmail"], target: ["email"] } } },
        },
      },
    });
    const { db, orm } = await setup(contract, { users: "id", posts: "id" });
    await orm["users"]!.create({ id: "u1", email: "a@e.com" });
    await orm["posts"]!.create({ id: "p1", authorEmail: "a@e.com" });
    await expect(orm["posts"]!.create({ id: "p2", authorEmail: "nobody@e.com" })).rejects.toThrow(/FK violation/);
    db.close();
  });

  it("parent has a COMPOUND primary key, even when the FK targets one member of it", async () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Org: {
          store: "orgs",
          key: ["orgId", "region"],
          fields: { orgId: "String", region: "String" },
          relations: { members: { to: "Member", cardinality: "1:N", on: { local: ["orgId"], target: ["orgId"] } } },
        },
        Member: {
          store: "members",
          key: "id",
          fields: { id: "String", orgId: "String" },
          relations: { org: { to: "Org", cardinality: "N:1", on: { local: ["orgId"], target: ["orgId"] } } },
        },
      },
    });
    const { db, orm } = await setup(contract, { orgs: ["orgId", "region"], members: "id" });
    await orm["orgs"]!.create({ orgId: "o1", region: "eu" });
    await orm["members"]!.create({ id: "m1", orgId: "o1" });
    await expect(orm["members"]!.create({ id: "m2", orgId: "nope" })).rejects.toThrow(/FK violation/);
    db.close();
  });

  it("rejects NaN before the FK lookup without an IndexedDB DataError", async () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Team: {
          store: "teams",
          key: "id",
          fields: { id: "Int" },
          relations: { members: { to: "Member", cardinality: "1:N", on: { local: ["id"], target: ["teamId"] } } },
        },
        Member: {
          store: "members",
          key: "id",
          fields: { id: "String", teamId: "Int" },
          relations: { team: { to: "Team", cardinality: "N:1", on: { local: ["teamId"], target: ["id"] } } },
        },
      },
    });
    const { db, orm } = await setup(contract, { teams: "id", members: "id" });
    await orm["teams"]!.create({ id: 1 });
    await expect(orm["members"]!.create({ id: "m1", teamId: Number.NaN })).rejects.toThrow(IdbRecordValidationError);
    await orm["members"]!.create({ id: "m2", teamId: 1 });
    db.close();
  });
});

// ── setDefault: parent-side validation ────────────────────────────────────────

describe("setDefault validation — default references the parent's primary key", () => {
  const contract = defineContract({
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

  let db: IDBDatabase;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, orm } = await setup(contract, { users: "id", posts: "id" }));
  });
  afterEach(() => db.close());

  it("passes when the default points at a real parent row", async () => {
    await orm["users"]!.create({ id: "system", name: "System" });
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["posts"]!.create({ id: "p1", title: "x", authorId: "u1" });
    await orm["users"]!.delete("u1");
    expect((await getAllRows(db, "posts"))[0]!["authorId"]).toBe("system");
  });

  it("throws when the default points at no row", async () => {
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["posts"]!.create({ id: "p1", title: "x", authorId: "u1" });
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/does not reference a real row/);
    expect((await getAllRows(db, "posts"))[0]!["authorId"]).toBe("u1");
    expect(await getAllRows(db, "users")).toHaveLength(1);
  });

  it("self-exclusion: the row being deleted can't satisfy its own default", async () => {
    // Deleting "system" would reset p1.authorId to "system" — the very row going away.
    await orm["users"]!.create({ id: "system", name: "System" });
    await orm["posts"]!.create({ id: "p1", title: "x", authorId: "system" });
    await expect(orm["users"]!.delete("system")).rejects.toThrow(/does not reference a real row/);
    expect(await getAllRows(db, "users")).toHaveLength(1);
  });
});

// ── restrict on a shared-primary-key 1:1 ──────────────────────────────────────

describe("restrict — shared-primary-key 1:1 (child's own PK is the FK)", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", name: "String" },
        relations: { profile: { to: "Profile", cardinality: "1:1", on: { local: ["id"], target: ["userId"] } } },
      },
      Profile: {
        store: "profiles",
        key: "userId",
        fields: { userId: "String", bio: "String" },
      },
    },
  });

  let db: IDBDatabase;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, orm } = await setup(contract, { users: "id", profiles: "userId" }));
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["users"]!.create({ id: "u2", name: "Bob" });
    await orm["profiles"]!.create({ userId: "u1", bio: "hi" });
  });
  afterEach(() => db.close());

  it("blocks deleting a parent whose profile exists", async () => {
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete User.*child records/);
    expect(await getAllRows(db, "users")).toHaveLength(2);
  });

  it("allows deleting a parent with no profile", async () => {
    await orm["users"]!.delete("u2");
    expect(await getAllRows(db, "users")).toHaveLength(1);
  });
});

// ── restrict and cascade on a 1:N ─────────────────────────────────────────────

describe("restrict and cascade on a 1:N", () => {
  it("restrict on a 1:N (child FK is not the child's PK)", async () => {
    const { db, orm } = await setup(userPostContract, { users: "id", posts: "id" });
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["posts"]!.create({ id: "p1", title: "x", authorId: "u1" });
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete User/);
    db.close();
  });

  it("cascade delete removes the children", async () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String" },
          relations: {
            posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "cascade" },
          },
        },
        Post: { store: "posts", key: "id", fields: { id: "String", authorId: "String" } },
      },
    });
    const { db, orm } = await setup(contract, { users: "id", posts: "id" });
    await orm["users"]!.create({ id: "u1" });
    await orm["posts"]!.create({ id: "p1", authorId: "u1" });
    await orm["users"]!.delete("u1");
    expect(await getAllRows(db, "posts")).toHaveLength(0);
    db.close();
  });
});

// ── restrict with a null referenced value ─────────────────────────────────────

// A child row with a null foreign-key field references no parent (SQL's
// MATCH SIMPLE), so a parent whose referenced field is null has no children,
// however many unrelated children carry null foreign keys.
describe("restrict — null in the parent's referenced fields", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Org: {
        store: "orgs",
        key: "id",
        fields: { id: "String", orgId: "String?", handle: "String?" },
        relations: {
          members: {
            to: "Member",
            cardinality: "1:N",
            on: { local: ["orgId", "handle"], target: ["memberOrgId", "memberHandle"] },
            onDelete: "restrict",
            onUpdate: "restrict",
          },
        },
      },
      Member: {
        store: "members",
        key: "id",
        fields: { id: "String", memberOrgId: "String?", memberHandle: "String?" },
      },
    },
  });

  async function seed() {
    const { db, orm } = await setup(contract, { orgs: "id", members: "id" });
    // Org rows: one fully set, one with a partly null tuple, one fully null.
    await orm["orgs"]!.create({ id: "full", orgId: "A", handle: "h" });
    await orm["orgs"]!.create({ id: "partial", orgId: "A", handle: null });
    await orm["orgs"]!.create({ id: "empty", orgId: null, handle: null });
    // Members with null foreign keys match none of the orgs above.
    await orm["members"]!.create({ id: "m-partial", memberOrgId: "A", memberHandle: null });
    await orm["members"]!.create({ id: "m-empty", memberOrgId: null, memberHandle: null });
    return { db, orm, members: await getAllRows(db, "members") };
  }

  it("delete: removes a parent with a partly null tuple and leaves the children alone", async () => {
    const { db, orm, members } = await seed();
    await orm["orgs"]!.delete("partial");
    expect((await getAllRows(db, "orgs")).map((o) => o["id"]).sort()).toEqual(["empty", "full"]);
    expect(await getAllRows(db, "members")).toEqual(members);
    db.close();
  });

  it("delete: removes a parent whose whole tuple is null and leaves the children alone", async () => {
    const { db, orm, members } = await seed();
    await orm["orgs"]!.delete("empty");
    expect((await getAllRows(db, "orgs")).map((o) => o["id"]).sort()).toEqual(["full", "partial"]);
    expect(await getAllRows(db, "members")).toEqual(members);
    db.close();
  });

  it("delete: still restricts a parent whose whole tuple matches a child", async () => {
    const { db, orm, members } = await seed();
    await orm["members"]!.create({ id: "m-full", memberOrgId: "A", memberHandle: "h" });
    await expect(orm["orgs"]!.delete("full")).rejects.toThrow(/Cannot delete Org/);
    expect(await getAllRows(db, "orgs")).toHaveLength(3);
    expect(await getAllRows(db, "members")).toHaveLength(members.length + 1);
    db.close();
  });

  it("update: changes a field of a partly null tuple and leaves the children alone", async () => {
    const { db, orm, members } = await seed();
    await orm["orgs"]!.where({ id: "partial" }).update({ handle: "h2" });
    expect((await getAllRows(db, "orgs")).find((o) => o["id"] === "partial")?.["handle"]).toBe("h2");
    expect(await getAllRows(db, "members")).toEqual(members);
    db.close();
  });

  it("update: changes a field of a whole-null tuple and leaves the children alone", async () => {
    const { db, orm, members } = await seed();
    await orm["orgs"]!.where({ id: "empty" }).update({ orgId: "B" });
    expect((await getAllRows(db, "orgs")).find((o) => o["id"] === "empty")?.["orgId"]).toBe("B");
    expect(await getAllRows(db, "members")).toEqual(members);
    db.close();
  });

  it("update: still restricts a change to a tuple that a child references", async () => {
    const { db, orm } = await seed();
    await orm["members"]!.create({ id: "m-full", memberOrgId: "A", memberHandle: "h" });
    await expect(orm["orgs"]!.where({ id: "full" }).update({ handle: "h2" })).rejects.toThrow(/Cannot update Org/);
    expect((await getAllRows(db, "orgs")).find((o) => o["id"] === "full")?.["handle"]).toBe("h");
    db.close();
  });
});
