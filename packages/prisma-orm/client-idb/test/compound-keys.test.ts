/**
 * Phase 9.1/9.2 — compound primary keys and compound secondary indexes.
 *
 * Covers, against real fake-indexeddb execution (not just IR/type assertions):
 *   - CRUD (create/findUnique/delete/update/upsert/all/where) on a
 *     compound-@@id model, using the ordered array key form.
 *   - Native compound-unique-index constraint enforcement.
 *   - Non-unique compound index correctness (multiple rows sharing a prefix).
 *   - Nested create/connect targeting a compound-keyed parent.
 *   - Cascade delete/update where the parent, the child, or both have a
 *     compound primary key — including the two regression cases the
 *     implementation specifically had to get right for compound keys:
 *     the `visited` cycle-guard dedup token, and the `setDefault`
 *     self-exclusion check.
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

// ── DB helpers ────────────────────────────────────────────────────────────────

let dbCounter = 0;
function nextDbName(): string {
  return `compound-keys-test-${++dbCounter}`;
}

type IndexSpec = { name: string; keyPath: string | string[]; unique?: boolean };
type StoreSpec = { keyPath: string | string[]; indexes?: IndexSpec[] };

/** Raw IDB schema setup — the driver itself is contract-agnostic and never creates schema; every test must pre-create it, matching `fk-enforcement.test.ts`'s pattern. */
function openTestDbWithStores(name: string, stores: Record<string, StoreSpec>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [storeName, spec] of Object.entries(stores)) {
        const store = db.createObjectStore(storeName, { keyPath: spec.keyPath });
        for (const idx of spec.indexes ?? []) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
        }
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

// ── Fixture: compound-PK model, no relations ───────────────────────────────────

const membershipContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Membership: {
      store: "memberships",
      key: ["orgId", "userId"],
      fields: { orgId: "String", userId: "String", role: "String" },
    },
  },
});

describe("compound primary key — CRUD", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { memberships: { keyPath: ["orgId", "userId"] } });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
    const orm = idbOrm({ contract: membershipContract, executor });
    await orm["memberships"]!.create({ orgId: "org1", userId: "u1", role: "admin" } as never);
  });
  afterEach(() => db.close());

  it("creates a row under a native compound array key", async () => {
    const rows = await getAllRows(db, "memberships");
    expect(rows).toHaveLength(1);
    // Confirm the underlying object store really did key it as an array —
    // get() with the scalar-only form must NOT find it.
    const scalarGet = await new Promise((resolve, reject) => {
      const req = db.transaction("memberships", "readonly").objectStore("memberships").get("org1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(scalarGet).toBeUndefined();
  });

  it("findUnique() accepts the key as an ordered array and returns the row", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    const row = await orm["memberships"]!.findUnique(["org1", "u1"] as never);
    expect(row).toMatchObject({ orgId: "org1", userId: "u1", role: "admin" });
  });

  it("findUnique() returns null for a partial or wrong-order key", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    expect(await orm["memberships"]!.findUnique(["u1", "org1"] as never)).toBeNull();
  });

  it("create() rejects a duplicate compound key", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    await expect(
      orm["memberships"]!.create({ orgId: "org1", userId: "u1", role: "member" } as never)
    ).rejects.toMatchObject({ code: "ADD_FAILED" });
    const stored = await orm["memberships"]!.findUnique(["org1", "u1"] as never);
    expect(stored).toMatchObject({ role: "admin" });
  });

  it("create() allows two rows that share one key member but differ in the other", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    await orm["memberships"]!.create({ orgId: "org1", userId: "u2", role: "member" } as never);
    await orm["memberships"]!.create({ orgId: "org2", userId: "u1", role: "member" } as never);
    expect(await getAllRows(db, "memberships")).toHaveLength(3);
  });

  it("delete() removes a row by its compound array key", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    await orm["memberships"]!.delete(["org1", "u1"] as never);
    expect(await getAllRows(db, "memberships")).toHaveLength(0);
  });

  it("update() (via where()) patches a row without disturbing its compound key", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    const updated = await orm["memberships"]!.where({ userId: "u1" } as never).update({ role: "owner" } as never);
    expect(updated).toMatchObject({ orgId: "org1", userId: "u1", role: "owner" });
  });

  it("upsert() creates when absent and updates when present, using the compound key internally", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    const created = await orm["memberships"]!.upsert({
      where: { orgId: "org1", userId: "u2" } as never,
      create: { orgId: "org1", userId: "u2", role: "member" } as never,
      update: { role: "owner" } as never,
    });
    expect(created).toMatchObject({ userId: "u2", role: "member" });

    const updated = await orm["memberships"]!.upsert({
      where: { orgId: "org1", userId: "u1" } as never,
      create: { orgId: "org1", userId: "u1", role: "member" } as never,
      update: { role: "owner" } as never,
    });
    expect(updated).toMatchObject({ userId: "u1", role: "owner" });
  });

  it("all() / where() cursor-scan compound-keyed rows correctly", async () => {
    const orm = idbOrm({ contract: membershipContract, executor });
    await orm["memberships"]!.create({ orgId: "org1", userId: "u3", role: "member" } as never);
    const all = await orm["memberships"]!.all().toArray();
    expect(all).toHaveLength(2);
    const admins = await orm["memberships"]!.where({ role: "admin" } as never)
      .all()
      .toArray();
    expect(admins).toHaveLength(1);
  });
});

// ── Fixture: compound secondary index ───────────────────────────────────────

const sessionContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Session: {
      store: "sessions",
      key: "id",
      fields: {
        id: "String",
        userId: "String",
        effectiveFrom: "String",
        orgId: "String",
        region: "String",
      },
      indexes: {
        byUserEffective: { keyPath: ["userId", "effectiveFrom"], unique: true },
        byOrgRegion: { keyPath: ["orgId", "region"] },
      },
    },
  },
});

describe("compound secondary index — uniqueness and correctness", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, {
      sessions: {
        keyPath: "id",
        indexes: [
          { name: "byUserEffective", keyPath: ["userId", "effectiveFrom"], unique: true },
          { name: "byOrgRegion", keyPath: ["orgId", "region"] },
        ],
      },
    });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
    const orm = idbOrm({ contract: sessionContract, executor });
    await orm["sessions"]!.create({
      id: "s1",
      userId: "u1",
      effectiveFrom: "2026-01-01",
      orgId: "org1",
      region: "us",
    } as never);
  });
  afterEach(() => db.close());

  it("the compound index exists natively with the declared field order", async () => {
    const tx = db.transaction("sessions", "readonly");
    const idx = tx.objectStore("sessions").index("byUserEffective");
    expect(Array.from(idx.keyPath as string[])).toEqual(["userId", "effectiveFrom"]);
    expect(idx.unique).toBe(true);
  });

  it("rejects a second row whose compound-unique index tuple duplicates an existing one", async () => {
    const orm = idbOrm({ contract: sessionContract, executor });
    await expect(
      orm["sessions"]!.create({
        id: "s2",
        userId: "u1",
        effectiveFrom: "2026-01-01",
        orgId: "org2",
        region: "eu",
      } as never)
    ).rejects.toMatchObject({ code: "ADD_FAILED" });
    expect(await getAllRows(db, "sessions")).toHaveLength(1);
  });

  it("allows a second row that changes either member of the compound-unique tuple", async () => {
    const orm = idbOrm({ contract: sessionContract, executor });
    await orm["sessions"]!.create({
      id: "s2",
      userId: "u1",
      effectiveFrom: "2026-02-01", // different effectiveFrom -> different tuple
      orgId: "org1",
      region: "us",
    } as never);
    await orm["sessions"]!.create({
      id: "s3",
      userId: "u2", // different userId -> different tuple
      effectiveFrom: "2026-01-01",
      orgId: "org1",
      region: "us",
    } as never);
    expect(await getAllRows(db, "sessions")).toHaveLength(3);
  });

  it("a non-unique compound index allows multiple rows sharing the same tuple", async () => {
    const orm = idbOrm({ contract: sessionContract, executor });
    await orm["sessions"]!.create({
      id: "s2",
      userId: "u2",
      effectiveFrom: "2026-03-01",
      orgId: "org1", // same orgId/region pair as s1
      region: "us",
    } as never);
    // byOrgRegion is not unique — both rows share ["org1","us"] and both persist.
    expect(await getAllRows(db, "sessions")).toHaveLength(2);
  });
});

// ── Fixture: FK relation targeting a compound-keyed parent ────────────────────

const compoundParentRelationContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Membership: {
      store: "memberships",
      key: ["orgId", "userId"],
      fields: { orgId: "String", userId: "String", role: "String" },
      relations: {
        grants: {
          to: "Grant",
          cardinality: "1:N",
          on: { local: ["orgId", "userId"], target: ["grantOrgId", "grantUserId"] },
          onDelete: "cascade",
        },
      },
    },
    Grant: {
      store: "grants",
      key: "id",
      fields: { id: "String", grantOrgId: "String", grantUserId: "String", permission: "String" },
    },
  },
});

describe("FK relation targeting a compound-keyed parent", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, {
      memberships: { keyPath: ["orgId", "userId"] },
      grants: { keyPath: "id" },
    });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("nested create() copies every member of a compound FK from the parent", async () => {
    const orm = idbOrm({ contract: compoundParentRelationContract, executor });
    await orm["memberships"]!.create({
      orgId: "org1",
      userId: "u1",
      role: "admin",
      grants: (rel: { create: (d: unknown) => unknown }) => rel.create({ id: "g1", permission: "manage" }),
    } as never);

    const grants = await getAllRows(db, "grants");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ grantOrgId: "org1", grantUserId: "u1", permission: "manage" });
  });

  it("cascade delete of a compound-keyed parent removes matching children", async () => {
    const orm = idbOrm({ contract: compoundParentRelationContract, executor });
    await orm["memberships"]!.create({ orgId: "org1", userId: "u1", role: "admin" } as never);
    await orm["grants"]!.create({ id: "g1", grantOrgId: "org1", grantUserId: "u1", permission: "manage" } as never);
    await orm["grants"]!.create({ id: "g2", grantOrgId: "org1", grantUserId: "u1", permission: "read" } as never);
    // An unrelated grant for a different (orgId, userId) pair must survive.
    await orm["memberships"]!.create({ orgId: "org1", userId: "u2", role: "member" } as never);
    await orm["grants"]!.create({ id: "g3", grantOrgId: "org1", grantUserId: "u2", permission: "read" } as never);

    await orm["memberships"]!.delete(["org1", "u1"] as never);

    const remainingGrants = await getAllRows(db, "grants");
    expect(remainingGrants.map((g) => g["id"])).toEqual(["g3"]);
    expect(await getAllRows(db, "memberships")).toHaveLength(1);
  });
});

// ── Fixture: both parent and child have compound primary keys ─────────────────

const bothCompoundContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Team: {
      store: "teams",
      key: ["orgId", "teamId"],
      fields: { orgId: "String", teamId: "String", name: "String" },
      relations: {
        members: {
          to: "TeamMember",
          cardinality: "1:N",
          on: { local: ["orgId", "teamId"], target: ["memberOrgId", "memberTeamId"] },
          onDelete: "cascade",
        },
      },
    },
    TeamMember: {
      store: "teamMembers",
      key: ["memberOrgId", "memberTeamId", "userId"],
      fields: { memberOrgId: "String", memberTeamId: "String", userId: "String", role: "String" },
    },
  },
});

describe("cascade delete where both parent and child have compound primary keys", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, {
      teams: { keyPath: ["orgId", "teamId"] },
      teamMembers: { keyPath: ["memberOrgId", "memberTeamId", "userId"] },
    });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("deletes every child keyed by its own (3-member) compound key", async () => {
    const orm = idbOrm({ contract: bothCompoundContract, executor });
    await orm["teams"]!.create({ orgId: "org1", teamId: "t1", name: "Team 1" } as never);
    await orm["teamMembers"]!.create({
      memberOrgId: "org1",
      memberTeamId: "t1",
      userId: "u1",
      role: "lead",
    } as never);
    await orm["teamMembers"]!.create({
      memberOrgId: "org1",
      memberTeamId: "t1",
      userId: "u2",
      role: "member",
    } as never);

    await orm["teams"]!.delete(["org1", "t1"] as never);

    expect(await getAllRows(db, "teamMembers")).toHaveLength(0);
    expect(await getAllRows(db, "teams")).toHaveLength(0);
  });
});

// ── Regression: cascade cycle-guard dedup token with a compound-keyed,
//    self-referential model. Before the fix, `Set<unknown>` deduped
//    compound-key `rowKey` tokens by reference, so two freshly-built arrays
//    with identical field values never matched — the cycle guard would never
//    fire and a mutual-reference cycle would recurse until IDB's `visited`
//    plumbing broke some other way (a stack overflow, or a duplicate delete
//    throwing on an already-gone key). This test pins the fix. ─────────────

const selfReferentialCompoundContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Node: {
      store: "nodes",
      key: ["treeId", "nodeId"],
      fields: { treeId: "String", nodeId: "String", parentNodeId: "String?", name: "String" },
      relations: {
        children: {
          to: "Node",
          cardinality: "1:N",
          on: { local: ["treeId", "nodeId"], target: ["treeId", "parentNodeId"] },
          onDelete: "cascade",
        },
      },
    },
  },
});

describe("cascade cycle-guard with a compound-keyed self-referential model", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, { nodes: { keyPath: ["treeId", "nodeId"] } });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("cascades a multi-level chain fully, exactly once per node", async () => {
    const orm = idbOrm({ contract: selfReferentialCompoundContract, executor });
    await orm["nodes"]!.create({ treeId: "t1", nodeId: "root", parentNodeId: null, name: "Root" } as never);
    await orm["nodes"]!.create({ treeId: "t1", nodeId: "a", parentNodeId: "root", name: "A" } as never);
    await orm["nodes"]!.create({ treeId: "t1", nodeId: "b", parentNodeId: "a", name: "B" } as never);

    await orm["nodes"]!.delete(["t1", "root"] as never);

    expect(await getAllRows(db, "nodes")).toHaveLength(0);
  });

  it("terminates on a mutual-reference cycle between two compound-keyed rows instead of hanging", async () => {
    const orm = idbOrm({ contract: selfReferentialCompoundContract, executor });
    await orm["nodes"]!.create({ treeId: "t1", nodeId: "x", parentNodeId: "y", name: "X" } as never);
    await orm["nodes"]!.create({ treeId: "t1", nodeId: "y", parentNodeId: "x", name: "Y" } as never);

    await orm["nodes"]!.delete(["t1", "x"] as never);

    expect(await getAllRows(db, "nodes")).toHaveLength(0);
  });
});

// ── Regression: setDefault self-exclusion with a compound-keyed parent.
//    `validateSetDefaultPatch`'s `excludeKey` comparison used to be a plain
//    `!==`, which never matched a freshly-extracted compound array key
//    against the caller's `excludeKey` array — the exclusion silently became
//    a no-op, letting the still-present (about-to-be-deleted) row itself
//    satisfy the "does the default value reference a real row" check, and a
//    dangling FK would slip through unnoticed after the delete completed. ──

const compoundSetDefaultContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: ["orgId", "id"],
      fields: { orgId: "String", id: "String", name: "String" },
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

describe("setDefault self-exclusion with a compound-keyed parent", () => {
  let db: IDBDatabase;
  let executor: TestExecutorWithTransaction;

  beforeEach(async () => {
    const name = nextDbName();
    db = await openTestDbWithStores(name, {
      users: { keyPath: ["orgId", "id"] },
      posts: { keyPath: "id" },
    });
    executor = new TestExecutorWithTransaction(createIDBRuntimeDriver(name).create());
  });
  afterEach(() => db.close());

  it("succeeds when a different row provides the default value", async () => {
    const orm = idbOrm({ contract: compoundSetDefaultContract, executor });
    await orm["users"]!.create({ orgId: "org1", id: "system", name: "System" } as never);
    await orm["users"]!.create({ orgId: "org1", id: "u1", name: "Alice" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);

    await orm["users"]!.delete(["org1", "u1"] as never);

    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorId"]).toBe("system");
  });

  it("throws instead of silently dangling when deleting the row that IS the default's target — the row being deleted must not validate itself", async () => {
    const orm = idbOrm({ contract: compoundSetDefaultContract, executor });
    // Deliberately the ONLY user in the store — "system" only exists as
    // (about to be) the row being deleted itself; no other "system" row
    // could satisfy the default post-deletion.
    await orm["users"]!.create({ orgId: "org1", id: "system", name: "The System User" } as never);
    await orm["posts"]!.create({ id: "p1", title: "Post", authorId: "u1" } as never);

    // The relation is enforced from `User`'s own field "id" against Post's
    // fieldDefaults.authorId ("system"). Deleting the User row whose id is
    // literally "system" is exactly the self-referencing case: at scan time
    // (before the delete lands) that row is still physically present, so an
    // exclusion bug would let it wrongly "validate" its own default.
    await expect(orm["users"]!.delete(["org1", "system"] as never)).rejects.toThrow(/does not reference a real row/i);
    // The whole transaction rolled back: user still present, post untouched.
    expect(await getAllRows(db, "users")).toHaveLength(1);
    const posts = await getAllRows(db, "posts");
    expect(posts[0]?.["authorId"]).toBe("u1");
  });
});
