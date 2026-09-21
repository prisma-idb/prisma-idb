/**
 * Phase 6.5 — Include refinement (where / orderBy / take / skip inside include)
 *
 * `include(rel, refineFn)` passes the related rows through a refined child
 * accessor: `where` filters them, `orderBy` + `take` + `skip` paginate them
 * per parent group (1:N). Exercised end-to-end against real Chromium IndexedDB.
 */
import { expect, test } from "../helpers";

type UserWithPosts = { id: string; posts: Array<{ id: string; views: number }> };

function findUser(rows: UserWithPosts[], id: string): UserWithPosts {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`user ${id} not found in result`);
  return row;
}

test.describe("include refinement", () => {
  test.beforeEach(async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob", email: "b@x.com", bio: null, score: 2, active: true, joinedAt: new Date() })`
    );
    // u1: p1(100,pub) p2(50,draft) p3(75,pub) | u2: p4(200,pub) p5(0,draft)
    const posts: Array<[string, string, number, boolean]> = [
      ["p1", "u1", 100, true],
      ["p2", "u1", 50, false],
      ["p3", "u1", 75, true],
      ["p4", "u2", 200, true],
      ["p5", "u2", 0, false],
    ];
    for (const [id, authorId, views, published] of posts) {
      await runner.run(
        `orm.posts.create({ id: "${id}", authorId: "${authorId}", title: "${id}", content: null, views: ${views}, published: ${published}, publishedAt: null })`
      );
    }
  });

  test("where() filters child rows per parent", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.users.include("posts", p => p.where({ published: true })).all()`
    )) as UserWithPosts[];
    expect(findUser(rows, "u1").posts).toHaveLength(2);
    expect(findUser(rows, "u2").posts).toHaveLength(1);
  });

  test("orderBy() + take() limits each parent group", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.users.include("posts", p => p.orderBy({ views: "desc" }).take(1)).all()`
    )) as UserWithPosts[];
    expect(findUser(rows, "u1").posts.map((p) => p.id)).toEqual(["p1"]); // 100 is u1's max
    expect(findUser(rows, "u2").posts.map((p) => p.id)).toEqual(["p4"]); // 200 is u2's max
  });

  test("where() composes with orderBy()", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.users.include("posts", p => p.where({ published: true }).orderBy({ views: "asc" })).all()`
    )) as UserWithPosts[];
    expect(findUser(rows, "u1").posts.map((p) => p.id)).toEqual(["p3", "p1"]); // 75, 100
  });

  test("skip() paginates each parent group", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.users.include("posts", p => p.orderBy({ views: "asc" }).skip(1)).all()`
    )) as UserWithPosts[];
    expect(findUser(rows, "u1").posts.map((p) => p.id)).toEqual(["p3", "p1"]); // drop p2(50)
  });
});
