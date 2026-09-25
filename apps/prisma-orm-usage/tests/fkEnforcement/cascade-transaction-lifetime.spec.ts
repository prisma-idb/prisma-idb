/**
 * Phase 9.5 — pins the transaction-lifetime assumption behind cascades.
 *
 * A cascade delete walks User → Post → Tag inside ONE IDB transaction that
 * relies on implicit auto-commit: every hop is chained from IDB request
 * callbacks/awaits, so the transaction must stay alive across all hops. These
 * are not feature tests — they fail if a stray non-IDB `await` (or a browser's
 * scheduling differences) ever lets the transaction commit mid-cascade. They
 * run in every configured browser project (Chromium + WebKit).
 */
import { expect, test } from "../helpers";

const user = (id: string) =>
  `{ id: "${id}", name: "U ${id}", email: "${id}@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const post = (id: string, authorId: string) =>
  `{ id: "${id}", title: "Post ${id}", content: null, views: 0, published: false, publishedAt: null, authorId: "${authorId}" }`;
const META = `{ target: "idb", storageHash: "", lane: "test", annotations: { groupingKey: "g1" } }`;
const tag = (id: string, postId: string) => `{ id: "${id}", name: "t${id}", postId: "${postId}" }`;

test.describe("cascade transaction lifetime", () => {
  test("3-level cascade (User → Post → Tag) commits atomically", async ({ runner }) => {
    await runner.run(`orm.users.create(${user("u1")})`);
    await runner.run(`orm.users.create(${user("u2")})`);
    for (const p of ["p1", "p2", "p3"]) await runner.run(`orm.posts.create(${post(p, "u1")})`);
    await runner.run(`orm.posts.create(${post("p9", "u2")})`);
    for (const [t, p] of [
      ["t1", "p1"],
      ["t2", "p1"],
      ["t3", "p2"],
      ["t4", "p3"],
      ["t9", "p9"],
    ] as const)
      await runner.run(`orm.tags.create(${tag(t, p)})`);

    await runner.run(`orm.users.delete("u1")`);

    expect(await runner.run(`orm.users.all().toArray()`)).toHaveLength(1);
    expect((await runner.run(`orm.posts.all().toArray()`)) as { id: string }[]).toEqual([
      expect.objectContaining({ id: "p9" }),
    ]);
    expect((await runner.run(`orm.tags.all().toArray()`)) as { id: string }[]).toEqual([
      expect.objectContaining({ id: "t9" }),
    ]);
  });

  test("wide-fanout cascade (40 posts × 3 tags) commits atomically", async ({ runner }) => {
    await runner.run(`orm.users.create(${user("u1")})`);
    await runner.run(`
      (async () => {
        for (let i = 0; i < 40; i++) {
          await orm.posts.create({ id: "p" + i, title: "P", content: null, views: 0, published: false, publishedAt: null, authorId: "u1" });
          for (let j = 0; j < 3; j++) await orm.tags.create({ id: "t" + i + "_" + j, name: "n", postId: "p" + i });
        }
      })()
    `);
    expect(await runner.run(`orm.tags.all().toArray()`)).toHaveLength(120);

    await runner.run(`orm.users.delete("u1")`);

    expect(await runner.run(`orm.users.all().toArray()`)).toHaveLength(0);
    expect(await runner.run(`orm.posts.all().toArray()`)).toHaveLength(0);
    expect(await runner.run(`orm.tags.all().toArray()`)).toHaveLength(0);
  });

  test("a failure after a multi-hop delete chain rolls back every store", async ({ runner }) => {
    await runner.run(`orm.users.create(${user("u1")})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.tags.create(${tag("t1", "p1")})`);

    // Same shape as a cascade (tags → posts → user, chained in one transaction),
    // failing after the last hop: nothing may have been committed.
    const del = (storeName: string, key: string) =>
      `{ meta: ${META}, kind: "delete", storeName: "${storeName}", key: "${key}" }`;
    await runner.expectError(
      `transaction(["users", "posts", "tags"], async (scope) => {
        await scope.execute(${del("tags", "t1")});
        await scope.execute(${del("posts", "p1")});
        await scope.execute(${del("users", "u1")});
        throw new Error("boom after deep chain");
      })`,
      "boom after deep chain"
    );

    expect(await runner.run(`orm.users.all().toArray()`)).toHaveLength(1);
    expect(await runner.run(`orm.posts.all().toArray()`)).toHaveLength(1);
    expect(await runner.run(`orm.tags.all().toArray()`)).toHaveLength(1);
  });

  test("awaiting non-IDB work inside a scope surfaces TRANSACTION_INACTIVE", async ({ runner }) => {
    const get = `{ meta: ${META}, kind: "key-get", storeName: "users", key: "u1" }`;
    await runner.expectError(
      `transaction(["users"], async (scope) => {
        await scope.execute(${get});
        await new Promise((r) => setTimeout(r, 0));
        await scope.execute(${get});
      })`,
      "no longer active"
    );
  });
});
