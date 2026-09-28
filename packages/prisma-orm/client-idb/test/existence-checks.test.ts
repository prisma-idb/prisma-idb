/**
 * Key-only existence reads (`IdbKeysPlan`) for FK checks.
 *
 * A lookup is key-only when its fields are exactly the parent's primary key
 * fields, in any order. Any other lookup stays a value-materializing
 * `cursor-scan`.
 *
 * Every test is behavioral first (same outcome/message as before the change);
 * a recording executor then pins which physical plan each lookup issued so
 * neither the fast path nor the fallbacks can regress silently.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbAtomicPlan, IdbRuntimeDriverInstance, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

// ── Recording executor ────────────────────────────────────────────────────────

/** Records every plan issued through a transaction scope (where FK lookups run). */
class RecordingExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  scopePlans: IdbAtomicPlan[] = [];
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
  async transaction(storeNames: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope> {
    const scope = await this.#driver.transaction(storeNames, mode);
    return {
      execute: (plan) => {
        this.scopePlans.push(plan);
        return scope.execute(plan);
      },
      commit: () => scope.commit(),
      rollback: () => scope.rollback(),
    };
  }
  /** Plans of `kind` against `storeName` recorded since the last reset. */
  on(storeName: string, kind: IdbAtomicPlan["kind"]): IdbAtomicPlan[] {
    return this.scopePlans.filter((p) => p.storeName === storeName && p.kind === kind);
  }
  reset(): void {
    this.scopePlans = [];
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let dbCounter = 0;
const nextDbName = () => `key-only-reads-test-${++dbCounter}`;

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

/** Opens a fresh DB with `stores`, and returns an ORM + recorder + the raw db. */
async function setup(contract: ReturnType<typeof defineContract>, stores: Record<string, string | string[]>) {
  const name = nextDbName();
  const db = await openTestDbWithStores(name, stores);
  const executor = new RecordingExecutor(createIDBRuntimeDriver(name).create());
  const orm = idbOrm({ contract, executor }) as unknown as Record<
    string,
    {
      create(d: unknown): Promise<unknown>;
      delete(k: unknown): Promise<unknown>;
      where(f: unknown): { update(p: unknown): Promise<unknown> };
    }
  >;
  return { db, executor, orm };
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
      fields: { id: "String", authorId: "String", title: "String" },
      relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
    },
  },
});

// ── validateScalarFks: FK → primary key ───────────────────────────────────────

describe("FK validation — target is the parent's primary key (key-only)", () => {
  let db: IDBDatabase;
  let executor: RecordingExecutor;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, executor, orm } = await setup(userPostContract, { users: "id", posts: "id" }));
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    executor.reset();
  });
  afterEach(() => db.close());

  it("accepts an FK to an existing parent, via a `keys` plan on the parent store", async () => {
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" });
    expect(await getAllRows(db, "posts")).toHaveLength(1);
    expect(executor.on("users", "keys")).toHaveLength(1);
    expect(executor.on("users", "cursor-scan")).toHaveLength(0);
    const plan = executor.on("users", "keys")[0] as { range?: IDBKeyRange; take?: number; indexName?: string };
    expect(plan.take).toBe(1);
    expect(plan.indexName).toBeUndefined();
    expect(plan.range!.lower).toBe("u1");
    expect(plan.range!.upper).toBe("u1");
  });

  it("rejects a missing parent with the unchanged FK-violation message", async () => {
    await expect(orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "ghost" })).rejects.toThrow(
      /FK violation on relation 'author': no User with id='ghost'/
    );
    expect(await getAllRows(db, "posts")).toHaveLength(0);
    expect(executor.on("users", "keys")).toHaveLength(1);
  });

  it("validates FKs on update via the same path", async () => {
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" });
    executor.reset();
    await expect(orm["posts"]!.where({ id: "p1" }).update({ authorId: "ghost" })).rejects.toThrow(/FK violation/);
    expect(executor.on("users", "keys")).toHaveLength(1);
  });

  it("skips validation entirely (no plan at all) when the FK value is null", async () => {
    await orm["posts"]!.create({ id: "p1", title: "Hello", authorId: null });
    expect(executor.on("users", "keys")).toHaveLength(0);
    expect(executor.on("users", "cursor-scan")).toHaveLength(0);
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
  let executor: RecordingExecutor;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, executor, orm } = await setup(dateContract, { periods: "startsAt", entries: "id" }));
    await orm["periods"]!.create({ startsAt: new Date("2026-01-01T00:00:00Z"), label: "Jan" });
    executor.reset();
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

// ── Fallbacks: the lookup must stay a cursor-scan ─────────────────────────────

describe("FK validation — falls back to cursor-scan when a key range can't express the lookup", () => {
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
    const { db, executor, orm } = await setup(contract, { users: "id", posts: "id" });
    await orm["users"]!.create({ id: "u1", email: "a@e.com" });
    executor.reset();
    await orm["posts"]!.create({ id: "p1", authorEmail: "a@e.com" });
    await expect(orm["posts"]!.create({ id: "p2", authorEmail: "nobody@e.com" })).rejects.toThrow(/FK violation/);
    expect(executor.on("users", "keys")).toHaveLength(0);
    expect(executor.on("users", "cursor-scan")).toHaveLength(2);
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
    const { db, executor, orm } = await setup(contract, { orgs: ["orgId", "region"], members: "id" });
    await orm["orgs"]!.create({ orgId: "o1", region: "eu" });
    executor.reset();
    await orm["members"]!.create({ id: "m1", orgId: "o1" });
    await expect(orm["members"]!.create({ id: "m2", orgId: "nope" })).rejects.toThrow(/FK violation/);
    expect(executor.on("orgs", "keys")).toHaveLength(0);
    expect(executor.on("orgs", "cursor-scan")).toHaveLength(2);
    db.close();
  });

  it("value is not a valid IDB key (NaN) — no DataError, plain FK violation", async () => {
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
    const { db, executor, orm } = await setup(contract, { teams: "id", members: "id" });
    await orm["teams"]!.create({ id: 1 });
    executor.reset();
    await expect(orm["members"]!.create({ id: "m1", teamId: Number.NaN })).rejects.toThrow(/FK violation/);
    expect(executor.on("teams", "keys")).toHaveLength(0);
    await orm["members"]!.create({ id: "m2", teamId: 1 });
    expect(executor.on("teams", "keys")).toHaveLength(1);
    db.close();
  });
});

// ── setDefault: parent-side validation ────────────────────────────────────────

describe("setDefault validation — default references the parent's primary key (key-only)", () => {
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
  let executor: RecordingExecutor;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, executor, orm } = await setup(contract, { users: "id", posts: "id" }));
  });
  afterEach(() => db.close());

  it("passes when the default points at a real parent row", async () => {
    await orm["users"]!.create({ id: "system", name: "System" });
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["posts"]!.create({ id: "p1", title: "x", authorId: "u1" });
    executor.reset();
    await orm["users"]!.delete("u1");
    expect((await getAllRows(db, "posts"))[0]!["authorId"]).toBe("system");
    expect(executor.on("users", "keys")).toHaveLength(1);
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
  let executor: RecordingExecutor;
  let orm: Awaited<ReturnType<typeof setup>>["orm"];

  beforeEach(async () => {
    ({ db, executor, orm } = await setup(contract, { users: "id", profiles: "userId" }));
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["users"]!.create({ id: "u2", name: "Bob" });
    await orm["profiles"]!.create({ userId: "u1", bio: "hi" });
    executor.reset();
  });
  afterEach(() => db.close());

  it("blocks deleting a parent whose profile exists, via a key-only lookup on the child store", async () => {
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete User.*child records/);
    expect(await getAllRows(db, "users")).toHaveLength(2);
    expect(executor.on("profiles", "keys")).toHaveLength(1);
    expect(executor.on("profiles", "cursor-scan")).toHaveLength(0);
  });

  it("allows deleting a parent with no profile", async () => {
    await orm["users"]!.delete("u2");
    expect(await getAllRows(db, "users")).toHaveLength(1);
    expect(executor.on("profiles", "keys")).toHaveLength(1);
  });
});

// ── Row-consuming and non-PK sites must NOT go key-only ───────────────────────

describe("sites that consume row values or aren't PK-targeted stay on cursor-scan", () => {
  it("restrict on a 1:N (child FK is not the child's PK)", async () => {
    const { db, executor, orm } = await setup(userPostContract, { users: "id", posts: "id" });
    await orm["users"]!.create({ id: "u1", name: "Alice" });
    await orm["posts"]!.create({ id: "p1", title: "x", authorId: "u1" });
    executor.reset();
    await expect(orm["users"]!.delete("u1")).rejects.toThrow(/Cannot delete User/);
    expect(executor.on("posts", "keys")).toHaveLength(0);
    expect(executor.on("posts", "cursor-scan")).toHaveLength(1);
    db.close();
  });

  it("cascade delete reads child ROWS (needed to recurse), so it never uses keys", async () => {
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
    const { db, executor, orm } = await setup(contract, { users: "id", posts: "id" });
    await orm["users"]!.create({ id: "u1" });
    await orm["posts"]!.create({ id: "p1", authorId: "u1" });
    executor.reset();
    await orm["users"]!.delete("u1");
    expect(await getAllRows(db, "posts")).toHaveLength(0);
    expect(executor.scopePlans.some((p) => p.kind === "keys")).toBe(false);
    db.close();
  });
});
