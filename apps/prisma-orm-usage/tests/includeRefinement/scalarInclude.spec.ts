/**
 * Phase 6.5 — Scalar include (`count()` inside an include refinement)
 *
 * `include(rel, (c) => c.count())` reduces a to-many relation to the number of
 * matching children — the parent's relation field becomes a `number`. A scalar
 * include on a to-one relation is rejected at build time.
 */
import { expect, test } from "../helpers";

type UserWithCount = { id: string; posts: number };

function findUser(rows: UserWithCount[], id: string): UserWithCount {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`user ${id} not found in result`);
  return row;
}

test.describe("scalar include — count()", () => {
  test.beforeEach(async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob", email: "b@x.com", bio: null, score: 2, active: true, joinedAt: new Date() })`
    );
    const posts: Array<[string, string, boolean]> = [
      ["p1", "u1", true],
      ["p2", "u1", false],
      ["p3", "u1", true],
      ["p4", "u2", true],
      ["p5", "u2", false],
    ];
    for (const [id, authorId, published] of posts) {
      await runner.run(
        `orm.posts.create({ id: "${id}", authorId: "${authorId}", title: "${id}", content: null, views: 0, published: ${published}, publishedAt: null })`
      );
    }
  });

  test("count() reduces a to-many relation to a number", async ({ runner }) => {
    const rows = (await runner.run(`orm.users.include("posts", p => p.count()).all()`)) as UserWithCount[];
    expect(findUser(rows, "u1").posts).toBe(3);
    expect(findUser(rows, "u2").posts).toBe(2);
  });

  test("count() honours a refined where()", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.users.include("posts", p => p.where({ published: true }).count()).all()`
    )) as UserWithCount[];
    expect(findUser(rows, "u1").posts).toBe(2);
    expect(findUser(rows, "u2").posts).toBe(1);
  });

  test("count() on a to-one relation is rejected", async ({ runner }) => {
    await runner.run(
      `orm.posts.create({ id: "p9", authorId: "u1", title: "x", content: null, views: 0, published: true, publishedAt: null })`
    );
    await expect(runner.run(`orm.posts.include("author", a => a.count()).all()`)).rejects.toThrow(/to-many/);
  });
});
