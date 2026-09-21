/**
 * Phase 6.4 — Nested relation writes: disconnect()
 *
 * Covers:
 * - N:1 parent-owned disconnect: post.update({ author: rel.disconnect() }) → sets authorId to null
 * - 1:N child-owned disconnect (all): user.update({ posts: rel.disconnect() }) → sets authorId to null on all children
 * - 1:N child-owned disconnect (criteria): user.update({ posts: rel.disconnect([{ id: "p1" }]) }) → targeted
 */
import { expect, test } from "../helpers";

const alice = `{ id: "u1", name: "Alice", email: "alice@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const post = (id: string, authorId: string) =>
  `{ id: "${id}", title: "Post ${id}", content: null, views: 0, published: false, publishedAt: null, authorId: "${authorId}" }`;

test.describe("nestedWrites / disconnect", () => {
  test("N:1 — post.update() with author disconnect sets authorId to null", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);

    await runner.run(`
      orm.posts.where({ id: "p1" }).update({
        author: (rel) => rel.disconnect(),
      })
    `);
    const updated = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: unknown } | null;
    expect(updated!.authorId).toBeNull();
  });

  test("1:N — user.update() with posts disconnect (all) sets authorId to null on all children", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u1")})`);

    await runner.run(`
      orm.users.where({ id: "u1" }).update({
        posts: (rel) => rel.disconnect(),
      })
    `);

    const p1 = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: unknown } | null;
    const p2 = (await runner.run(`orm.posts.findUnique("p2")`)) as { authorId: unknown } | null;
    expect(p1!.authorId).toBeNull();
    expect(p2!.authorId).toBeNull();
  });

  test("1:N — user.update() with posts disconnect (criteria) targets only matching children", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u1")})`);

    await runner.run(`
      orm.users.where({ id: "u1" }).update({
        posts: (rel) => rel.disconnect([{ id: "p1" }]),
      })
    `);

    const p1 = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: unknown } | null;
    const p2 = (await runner.run(`orm.posts.findUnique("p2")`)) as { authorId: unknown } | null;
    expect(p1!.authorId).toBeNull();
    expect(p2!.authorId).toBe("u1");
  });
});
