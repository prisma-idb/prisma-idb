/**
 * Rows stored before a nullable field existed.
 *
 * The seeded rows have no `nickname` or `subtitle` key, as if the contract
 * gained those fields after the rows were written. Every read path must
 * return `null` for them, and `where({ field: null })` must match them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import { createIdbClient } from "../src/exports/client";
import type { IdbStoreAccessor } from "../src/exports/orm";

type Accessor = IdbStoreAccessor<never, never>;
type Row = Record<string, unknown>;

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String", nickname: "String?" },
      relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
      indexes: { byNickname: { keyPath: "nickname", unique: false } },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String", title: "String", subtitle: "String?" },
      relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
    },
  },
});

// Stored before `nickname` and `subtitle` existed. `u3` and `p3` have the fields, set to a value or to null.
const USERS: Row[] = [
  { id: "u1", name: "Alice" },
  { id: "u2", name: "Bob" },
  { id: "u3", name: "Carol", nickname: "Cy" },
  { id: "u4", name: "Dan", nickname: null },
];
const POSTS: Row[] = [
  { id: "p1", authorId: "u1", title: "Hello" },
  { id: "p2", authorId: "u1", title: "World", subtitle: "Part two" },
  { id: "p3", authorId: "u3", title: "Other", subtitle: null },
];

let dbCounter = 0;

function seed(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("users", { keyPath: "id" }).createIndex("byNickname", "nickname");
      db.createObjectStore("posts", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["users", "posts"], "readwrite");
      for (const user of USERS) tx.objectStore("users").put(user);
      for (const post of POSTS) tx.objectStore("posts").put(post);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("rows stored without a nullable field", () => {
  let client: ReturnType<typeof createIdbClient>;
  let users: Accessor;
  let posts: Accessor;

  beforeEach(async () => {
    const name = `absent-nullable-${++dbCounter}`;
    await seed(name);
    client = createIdbClient({ contract, dbName: name });
    const orm = client.orm as unknown as Record<string, Accessor>;
    users = orm["users"]!;
    posts = orm["posts"]!;
  });

  afterEach(async () => {
    await client.close();
  });

  const byId = (rows: Row[]) => [...rows].sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));

  it("reads the field as null in all()", async () => {
    const rows = byId((await users.all().toArray()) as Row[]);
    expect(rows.map((row) => row["nickname"])).toEqual([null, null, "Cy", null]);
    expect(rows[0]).toEqual({ id: "u1", name: "Alice", nickname: null });
  });

  it("reads the field as null in findUnique() and first()", async () => {
    expect(await users.findUnique("u1" as never)).toEqual({ id: "u1", name: "Alice", nickname: null });
    expect(await users.where({ id: "u2" }).first()).toEqual({ id: "u2", name: "Bob", nickname: null });
  });

  it("keeps the field in a select() projection", async () => {
    const rows = (await users.select("id", "nickname").all().toArray()) as Row[];
    expect(byId(rows)).toEqual([
      { id: "u1", nickname: null },
      { id: "u2", nickname: null },
      { id: "u3", nickname: "Cy" },
      { id: "u4", nickname: null },
    ]);
  });

  it("matches where({ field: null }) on absent and null rows alike", async () => {
    const matched = (await users.where({ nickname: null }).all().toArray()) as Row[];
    expect(byId(matched).map((row) => row["id"])).toEqual(["u1", "u2", "u4"]);
    expect(await users.where({ nickname: null }).count()).toBe(3);
  });

  it("matches in and notIn lists holding null on a field the row lacks", async () => {
    expect(await posts.where(() => fieldFilter("subtitle", "in", [null])).count()).toBe(2);
    expect(await posts.where(() => fieldFilter("subtitle", "notIn", [null])).count()).toBe(1);
  });

  it("reads the field as null in a 1:N relation load", async () => {
    const rows = (await users.where({ id: "u1" }).include("posts").all().toArray()) as unknown as {
      posts: Row[];
    }[];
    expect(byId(rows[0]!.posts)).toEqual([
      { id: "p1", authorId: "u1", title: "Hello", subtitle: null },
      { id: "p2", authorId: "u1", title: "World", subtitle: "Part two" },
    ]);
  });

  it("reads the field as null in an N:1 relation load and a nested include", async () => {
    const rows = (await posts.where({ id: "p1" }).include("author").all().toArray()) as unknown as {
      author: Row;
    }[];
    expect(rows[0]!.author).toEqual({ id: "u1", name: "Alice", nickname: null });
    const nested = (await users
      .where({ id: "u1" })
      .include("posts", (posts) => posts.where({ id: "p1" }))
      .all()
      .toArray()) as unknown as { posts: Row[] }[];
    expect(nested[0]!.posts).toEqual([{ id: "p1", authorId: "u1", title: "Hello", subtitle: null }]);
  });

  it("sorts and groups absent values with null", async () => {
    const sorted = (await users.orderBy({ nickname: "asc", id: "asc" }).all().toArray()) as Row[];
    expect(sorted.map((row) => row["id"])).toEqual(["u3", "u1", "u2", "u4"]);
    const groups = await users.groupBy("nickname" as never).aggregate((a) => ({ n: a.count() }));
    expect(groups).toEqual(
      expect.arrayContaining([
        { nickname: null, n: 3 },
        { nickname: "Cy", n: 1 },
      ])
    );
    expect(groups).toHaveLength(2);
  });

  it("reads the field as null in the row an update returns", async () => {
    expect(await users.where({ id: "u1" }).update({ name: "Alicia" })).toEqual({
      id: "u1",
      name: "Alicia",
      nickname: null,
    });
    const all = (await users.where({ id: "u2" }).updateAll({ name: "Rob" }).toArray()) as Row[];
    expect(all).toEqual([{ id: "u2", name: "Rob", nickname: null }]);
    const upserted = await users.upsert({
      where: { id: "u1" },
      create: { id: "u1", name: "unused", nickname: null },
      update: { name: "Ally" },
    } as never);
    expect(upserted).toEqual({ id: "u1", name: "Ally", nickname: null });
  });

  it("reads the field as null in the rows deleteAll returns", async () => {
    const deleted = (await posts.where({ id: "p1" }).deleteAll().toArray()) as Row[];
    expect(deleted).toEqual([{ id: "p1", authorId: "u1", title: "Hello", subtitle: null }]);
  });
});
