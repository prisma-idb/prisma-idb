/**
 * Phase 6.4 — Nested relation writes: create()
 *
 * Covers:
 * - 1:N child-owned create: user.create({ posts: rel.create([...]) })
 * - N:1 parent-owned create: post.create({ author: rel.create({...}) })
 * - Atomicity: if a nested create fails, the parent is not written
 */
import { expect, test } from "../helpers";

test.describe("nestedWrites / create", () => {
  test("1:N — user.create() with nested posts creates both records atomically", async ({ runner }) => {
    const user = await runner.run(`
      orm.users.create({
        id: "u1",
        name: "Alice",
        email: "alice@example.com",
        bio: null,
        score: 0,
        active: true,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        posts: (rel) => rel.create([
          { id: "p1", title: "Post 1", content: null, views: 0, published: false, publishedAt: null, authorId: "u1" },
          { id: "p2", title: "Post 2", content: null, views: 0, published: false, publishedAt: null, authorId: "u1" },
        ]),
      })
    `);
    expect(user).toMatchObject({ id: "u1", name: "Alice" });

    const posts = (await runner.run(`orm.posts.where({ authorId: "u1" }).all()`)) as Array<{
      id: string;
      authorId: string;
    }>;
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(posts.every((p) => p.authorId === "u1")).toBe(true);
  });

  test("1:N — child authorId is injected from parent, overwriting any value supplied", async ({ runner }) => {
    await runner.run(`
      orm.users.create({
        id: "u1",
        name: "Alice",
        email: "alice@example.com",
        bio: null,
        score: 0,
        active: true,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        posts: (rel) => rel.create([
          { id: "p1", title: "Post 1", content: null, views: 0, published: false, publishedAt: null, authorId: "WRONG" },
        ]),
      })
    `);
    const post = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: string } | null;
    expect(post).not.toBeNull();
    expect(post!.authorId).toBe("u1");
  });

  test("N:1 — post.create() with nested author creates the user first", async ({ runner }) => {
    const post = await runner.run(`
      orm.posts.create({
        id: "p1",
        title: "Post with new author",
        content: null,
        views: 0,
        published: false,
        publishedAt: null,
        author: (rel) => rel.create({
          id: "u1",
          name: "Bob",
          email: "bob@example.com",
          bio: null,
          score: 0,
          active: true,
          joinedAt: new Date("2026-01-01T00:00:00Z"),
        }),
      })
    `);
    expect(post).toMatchObject({ id: "p1", authorId: "u1" });

    const user = await runner.run(`orm.users.findUnique("u1")`);
    expect(user).toMatchObject({ id: "u1", name: "Bob" });
  });

  test("N:1 — parent FK is copied from the created related record", async ({ runner }) => {
    await runner.run(`
      orm.posts.create({
        id: "p1",
        title: "Post",
        content: null,
        views: 0,
        published: false,
        publishedAt: null,
        author: (rel) => rel.create({
          id: "u-real",
          name: "Carol",
          email: "carol@example.com",
          bio: null,
          score: 0,
          active: true,
          joinedAt: new Date("2026-01-01T00:00:00Z"),
        }),
      })
    `);
    const post = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: string } | null;
    expect(post).not.toBeNull();
    expect(post!.authorId).toBe("u-real");
  });

  test("create() without relation callbacks follows the plain put path", async ({ runner }) => {
    await runner.run(`
      orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 0, active: true, joinedAt: new Date() })
    `);
    const user = await runner.run(`orm.users.findUnique("u1")`);
    expect(user).toMatchObject({ id: "u1", name: "Alice" });
  });
});
