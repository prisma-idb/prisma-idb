/**
 * Phase 6.7 — select() projection
 *
 * `select(...fields)` narrows the returned row to the chosen scalar fields.
 * Included relations are preserved, and relation loading still works even when
 * the local FK field is not selected (rows are materialised, relations loaded,
 * then projected). Run end-to-end against real Chromium IndexedDB.
 */
import { expect, test } from "../helpers";

test.describe("select()", () => {
  test("narrows the row to the chosen fields", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "alice@test.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.posts.create({ id: "p1", authorId: "u1", title: "Hi", content: null, views: 3, published: true, publishedAt: null })`
    );
    const rows = (await runner.run(`orm.posts.select("id", "title").all()`)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "title"]);
    expect(rows[0]).toEqual({ id: "p1", title: "Hi" });
  });

  test("composes with where()", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "alice@test.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.posts.create({ id: "p1", authorId: "u1", title: "A", content: null, views: 1, published: true, publishedAt: null })`
    );
    await runner.run(
      `orm.posts.create({ id: "p2", authorId: "u1", title: "B", content: null, views: 2, published: false, publishedAt: null })`
    );
    const rows = (await runner.run(`orm.posts.where({ published: true }).select("id").all()`)) as Array<
      Record<string, unknown>
    >;
    expect(rows).toEqual([{ id: "p1" }]);
  });

  test("preserves included relation fields and loads them without selecting the FK", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.posts.create({ id: "p1", authorId: "u1", title: "Hi", content: null, views: 0, published: true, publishedAt: null })`
    );
    await runner.run(
      `orm.posts.create({ id: "p2", authorId: "u1", title: "Yo", content: null, views: 0, published: true, publishedAt: null })`
    );
    // select("name") drops the local FK ("id"), but include runs before
    // projection, so posts still resolve.
    const rows = (await runner.run(`orm.users.select("name").include("posts").all()`)) as Array<{
      name: string;
      posts: unknown[];
    }>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["name", "posts"]);
    expect(rows[0]!.name).toBe("Alice");
    expect(rows[0]!.posts).toHaveLength(2);
  });
});
