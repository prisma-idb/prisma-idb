/**
 * `include()` on a relation with a compound foreign key.
 *
 * The join has to match every field of the relation. Joining on one field
 * attaches the wrong rows whenever two parents share that field's value, such
 * as two members with the same handle in different orgs.
 *
 * Each variant stores the same data but gives the join a different way to find
 * related rows: no index, the parent's compound primary key, or a compound
 * index.
 */
import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack, { type IdbKeyPath } from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
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

type Row = Record<string, unknown>;
type Accessor = {
  create(d: Row): Promise<unknown>;
  include(rel: string, refine?: (r: { count(): unknown }) => unknown): { all(): { toArray(): Promise<Row[]> } };
};

type StoreSpec = { keyPath: IdbKeyPath; indexes?: Record<string, IdbKeyPath> };

let dbCounter = 0;

function openDb(name: string, stores: Record<string, StoreSpec>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const [storeName, spec] of Object.entries(stores)) {
        const store = req.result.createObjectStore(storeName, { keyPath: spec.keyPath as string | string[] });
        for (const [indexName, keyPath] of Object.entries(spec.indexes ?? {})) {
          store.createIndex(indexName, keyPath as string | string[]);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// The relation lists its fields as [handle, orgId]. The primary key and the
// indexes below list them as [orgId, handle], so the join has to reorder the
// values to build a key.
function contractFor(members: StoreSpec, posts: StoreSpec) {
  const indexes = (spec: StoreSpec) =>
    Object.fromEntries(Object.entries(spec.indexes ?? {}).map(([name, keyPath]) => [name, { keyPath }]));
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Member: {
        store: "members",
        key: members.keyPath,
        fields: { id: "String", orgId: "String", handle: "String", name: "String" },
        indexes: indexes(members),
        relations: {
          posts: { to: "Post", cardinality: "1:N", on: { local: ["handle", "orgId"], target: ["handle", "orgId"] } },
        },
      },
      Post: {
        store: "posts",
        key: posts.keyPath,
        fields: { id: "String", orgId: "String", handle: "String?", title: "String" },
        indexes: indexes(posts),
        relations: {
          author: { to: "Member", cardinality: "N:1", on: { local: ["handle", "orgId"], target: ["handle", "orgId"] } },
        },
      },
    },
  });
}

const variants: Array<{
  name: string;
  members: StoreSpec;
  posts: StoreSpec;
}> = [
  {
    name: "no index covers the fields",
    members: { keyPath: "id" },
    posts: { keyPath: "id" },
  },
  {
    name: "the parent's compound primary key covers the fields",
    members: { keyPath: ["orgId", "handle"] },
    posts: { keyPath: "id" },
  },
  {
    name: "compound indexes cover the fields",
    members: { keyPath: "id", indexes: { byOrgHandle: ["orgId", "handle"] } },
    posts: { keyPath: "id", indexes: { byAuthor: ["orgId", "handle"] } },
  },
];

describe.each(variants)("include() on a compound relation: $name", (variant) => {
  let db: IDBDatabase;
  let orm: Record<string, Accessor>;

  beforeEach(async () => {
    const name = `compound-relation-include-${++dbCounter}`;
    db = await openDb(name, { members: variant.members, posts: variant.posts });
    const executor = new TestExecutor(createIDBRuntimeDriver(name).create());
    orm = idbOrm({ contract: contractFor(variant.members, variant.posts), executor }) as unknown as Record<
      string,
      Accessor
    >;

    // Two members share the handle "alice" in different orgs.
    await orm["members"]!.create({ id: "m1", orgId: "org-A", handle: "alice", name: "Alice (A)" });
    await orm["members"]!.create({ id: "m2", orgId: "org-B", handle: "alice", name: "Alice (B)" });
    await orm["members"]!.create({ id: "m3", orgId: "org-A", handle: "bob", name: "Bob" });
    await orm["posts"]!.create({ id: "p1", orgId: "org-A", handle: "alice", title: "A1" });
    await orm["posts"]!.create({ id: "p2", orgId: "org-B", handle: "alice", title: "B1" });
    await orm["posts"]!.create({ id: "p3", orgId: "org-B", handle: "alice", title: "B2" });
    await orm["posts"]!.create({ id: "p4", orgId: "org-A", handle: "bob", title: "Bob1" });
    await orm["posts"]!.create({ id: "p5", orgId: "org-A", handle: null, title: "No author" });
  });

  afterEach(() => db.close());

  it("N:1 attaches the parent that matches every field", async () => {
    const posts = await orm["posts"]!.include("author").all().toArray();
    const authorOf = Object.fromEntries(posts.map((p) => [p["id"], (p["author"] as Row | null)?.["name"] ?? null]));
    expect(authorOf).toEqual({ p1: "Alice (A)", p2: "Alice (B)", p3: "Alice (B)", p4: "Bob", p5: null });
  });

  it("1:N attaches only the children that match every field", async () => {
    const members = await orm["members"]!.include("posts").all().toArray();
    const postsOf = Object.fromEntries(members.map((m) => [m["id"], (m["posts"] as Row[]).map((p) => p["id"]).sort()]));
    expect(postsOf).toEqual({ m1: ["p1"], m2: ["p2", "p3"], m3: ["p4"] });
  });

  it("1:N count counts only the children that match every field", async () => {
    const members = await orm["members"]!.include("posts", (r) => r.count())
      .all()
      .toArray();
    expect(Object.fromEntries(members.map((m) => [m["id"], m["posts"]]))).toEqual({ m1: 1, m2: 2, m3: 1 });
  });
});
