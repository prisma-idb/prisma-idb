/**
 * Filter operator API integration tests.
 *
 * Exercises the full stack: model accessor proxy → AST → store accessor
 * → cursor scan → evaluateFilter. Covers every operator on real
 * fake-indexeddb data, plus the and/or/not combinators.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { and, idbOrm, not, or } from "../src/exports/orm";
import type { IdbQueryExecutor, IdbStoreAccessor } from "../src/exports/orm";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: {
        id: "String",
        name: "String",
        email: "String",
        bio: "String?",
        score: "Int",
        active: "Boolean",
      },
    },
  },
});

class TestExecutor implements IdbQueryExecutor {
  constructor(readonly driver: IdbRuntimeDriverInstance) {}
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const it = this.driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of it) yield row as Row;
      })()
    );
  }
}

function asRecord(orm: unknown): Record<string, IdbStoreAccessor<never, never>> {
  return orm as Record<string, IdbStoreAccessor<never, never>>;
}

let counter = 0;
const dbName = () => `op-test-${++counter}`;

function openSeeded(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("users", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const ROWS = [
  { id: "u1", name: "Alice", email: "alice@example.com", bio: null, score: 100, active: true },
  { id: "u2", name: "Bob", email: "bob@example.com", bio: "Bob bio", score: 50, active: false },
  { id: "u3", name: "Carol", email: "carol@example.com", bio: "Carol bio", score: 75, active: true },
  // No bio field at all — exercises the undefined vs null distinction.
  { id: "u4", name: "Dave", email: "dave@example.com", score: 25, active: true },
] as const;

async function seed(name: string): Promise<void> {
  const db = await openSeeded(name);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["users"], "readwrite");
    const store = tx.objectStore("users");
    for (const row of ROWS) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe("where() — shorthand form", () => {
  let driver: IdbRuntimeDriverInstance;
  let exec: TestExecutor;
  beforeEach(async () => {
    const name = dbName();
    await seed(name);
    driver = createIDBRuntimeDriver(name, 1).create();
    exec = new TestExecutor(driver);
  });
  afterEach(() => driver.close());

  function client() {
    return asRecord(idbOrm({ contract, executor: exec }));
  }

  it("filters by equality on a single field", async () => {
    const rows = (await client()["users"]!.where({ name: "Alice" }).all().toArray()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });

  it("treats null in shorthand as null-check (matches null + undefined)", async () => {
    const rows = (await client()["users"]!.where({ bio: null }).all().toArray()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u4"]);
  });
});

describe("where() — callback form: single-field operators", () => {
  let driver: IdbRuntimeDriverInstance;
  let exec: TestExecutor;
  beforeEach(async () => {
    const name = dbName();
    await seed(name);
    driver = createIDBRuntimeDriver(name, 1).create();
    exec = new TestExecutor(driver);
  });
  afterEach(() => driver.close());

  function client() {
    return asRecord(idbOrm({ contract, executor: exec }));
  }

  it("eq", async () => {
    const rows = (await client()
      ["users"]!.where((m) => m["email"]!.eq("bob@example.com"))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["u2"]);
  });

  it("neq", async () => {
    const rows = (await client()
      ["users"]!.where((m) => m["active"]!.neq(true))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["u2"]);
  });

  it("gt / lt / gte / lte", async () => {
    const c = client();
    const gt = (await c["users"]!.where((m) => m["score"]!.gt(50))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(gt.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
    const lt = (await c["users"]!.where((m) => m["score"]!.lt(50))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(lt.map((r) => r.id)).toEqual(["u4"]);
    const gte = (await c["users"]!.where((m) => m["score"]!.gte(75))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(gte.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
    const lte = (await c["users"]!.where((m) => m["score"]!.lte(50))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(lte.map((r) => r.id).sort()).toEqual(["u2", "u4"]);
  });

  it("in / notIn", async () => {
    const c = client();
    const inn = (await c["users"]!.where((m) => m["name"]!.in(["Alice", "Bob"]))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(inn.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
    const notIn = (await c["users"]!.where((m) => m["name"]!.notIn(["Alice", "Bob"]))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(notIn.map((r) => r.id).sort()).toEqual(["u3", "u4"]);
  });

  it("contains / startsWith / endsWith on strings", async () => {
    const c = client();
    const con = (await c["users"]!.where((m) => m["email"]!.contains("arol"))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(con.map((r) => r.id)).toEqual(["u3"]);
    const sw = (await c["users"]!.where((m) => m["email"]!.startsWith("bob"))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(sw.map((r) => r.id)).toEqual(["u2"]);
    const ew = (await c["users"]!.where((m) => m["email"]!.endsWith("example.com"))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(ew).toHaveLength(4);
  });

  it("isNull / isNotNull (treats undefined and null as equivalent)", async () => {
    const c = client();
    const isNull = (await c["users"]!.where((m) => m["bio"]!.isNull())
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(isNull.map((r) => r.id).sort()).toEqual(["u1", "u4"]);
    const isNotNull = (await c["users"]!.where((m) => m["bio"]!.isNotNull())
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(isNotNull.map((r) => r.id).sort()).toEqual(["u2", "u3"]);
  });
});

describe("where() — callback form: combinators", () => {
  let driver: IdbRuntimeDriverInstance;
  let exec: TestExecutor;
  beforeEach(async () => {
    const name = dbName();
    await seed(name);
    driver = createIDBRuntimeDriver(name, 1).create();
    exec = new TestExecutor(driver);
  });
  afterEach(() => driver.close());

  function client() {
    return asRecord(idbOrm({ contract, executor: exec }));
  }

  it("and(a, b) intersects two predicates", async () => {
    const rows = (await client()
      ["users"]!.where((m) => and(m["active"]!.eq(true), m["score"]!.gte(75)))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  it("or(a, b) unions two predicates", async () => {
    const rows = (await client()
      ["users"]!.where((m) => or(m["name"]!.eq("Alice"), m["name"]!.eq("Bob")))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  it("not(e) inverts the predicate", async () => {
    const rows = (await client()
      ["users"]!.where((m) => not(m["active"]!.eq(true)))
      .all()
      .toArray()) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["u2"]);
  });

  it("nested combinators: and(or(...), not(...))", async () => {
    const rows = (await client()
      ["users"]!.where((m) => and(or(m["name"]!.eq("Alice"), m["name"]!.eq("Carol")), not(m["score"]!.lt(80))))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["u1"]); // Alice scores 100; Carol scores 75 → excluded by not(<80)
  });

  it("multiple .where() calls compose with AND", async () => {
    const rows = (await client()
      ["users"]!.where((m) => m["active"]!.eq(true))
      .where((m) => m["score"]!.gt(50))
      .all()
      .toArray()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });
});
