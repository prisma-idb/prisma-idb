/**
 * Phase 6.4 — Nested relation writes: connect()
 *
 * Covers:
 * - N:1 parent-owned connect: post.create({ author: rel.connect({ id: "u1" }) })
 * - N:1 connect in update: post.update({ author: rel.connect({ id: "u2" }) })
 * - 1:N child-owned connect: user.update({ posts: rel.connect([{ id: "p1" }]) })
 * - connect() throws when the referenced row does not exist
 */
import { expect, test } from "../helpers";

const alice = `{ id: "u1", name: "Alice", email: "alice@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const bob = `{ id: "u2", name: "Bob", email: "bob@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const post = (id: string, authorId: string) =>
  `{ id: "${id}", title: "Post ${id}", content: null, views: 0, published: false, publishedAt: null, authorId: "${authorId}" }`;

test.describe("nestedWrites / connect", () => {
  test("N:1 — post.create() with author connect links the existing user", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    const p = await runner.run(`
      orm.posts.create({
        id: "p1",
        title: "Post",
        content: null,
        views: 0,
        published: false,
        publishedAt: null,
        author: (rel) => rel.connect({ id: "u1" }),
      })
    `);
    expect(p).toMatchObject({ id: "p1", authorId: "u1" });
  });

  test("N:1 — post.update() with author connect re-links to a different user", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.users.create(${bob})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);

    await runner.run(`
      orm.posts.where({ id: "p1" }).update({
        author: (rel) => rel.connect({ id: "u2" }),
      })
    `);
    const updated = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: string } | null;
    expect(updated!.authorId).toBe("u2");
  });

  test("1:N — user.update() with posts connect sets FK on the child row", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.users.create(${bob})`);
    // p1 initially belongs to u2
    await runner.run(`orm.posts.create(${post("p1", "u2")})`);

    await runner.run(`
      orm.users.where({ id: "u1" }).update({
        posts: (rel) => rel.connect([{ id: "p1" }]),
      })
    `);
    const updated = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: string } | null;
    expect(updated!.authorId).toBe("u1");
  });

  test("N:1 connect() throws when referenced user does not exist", async ({ runner }) => {
    await runner.expectError(
      `
        orm.posts.create({
          id: "p1",
          title: "Post",
          content: null,
          views: 0,
          published: false,
          publishedAt: null,
          author: (rel) => rel.connect({ id: "nonexistent" }),
        })
      `,
      "connect"
    );
    const p = await runner.run(`orm.posts.findUnique("p1")`);
    expect(p).toBeNull();
  });
});
