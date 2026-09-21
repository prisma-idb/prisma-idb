/**
 * Phase 6.8 — FK validation + referential action enforcement (Playwright).
 *
 * Uses the demo contract where User.posts has onDelete: "cascade".
 *
 * Covers:
 *   cascade delete   — deleting a User cascades to their Posts
 *   restrict delete  — Post.author has no onDelete → restrict by default
 *                      (checked via scalar FK path: creating a Post with
 *                       a nonexistent authorId throws)
 *   scalar FK create — creating a Post with a nonexistent authorId throws
 *   scalar FK update — updating a Post's authorId to nonexistent throws
 */
import { expect, test } from "../helpers";

const alice = `{ id: "u1", name: "Alice", email: "alice@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const bob = `{ id: "u2", name: "Bob", email: "bob@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const post = (id: string, authorId: string) =>
  `{ id: "${id}", title: "Post ${id}", content: null, views: 0, published: false, publishedAt: null, authorId: "${authorId}" }`;

test.describe("fkEnforcement / cascade delete", () => {
  test("deleting a user cascades to their posts", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u1")})`);
    await runner.run(`orm.users.delete("u1")`);

    const users = (await runner.run(`orm.users.all().toArray()`)) as unknown[];
    expect(users).toHaveLength(0);

    const posts = (await runner.run(`orm.posts.all().toArray()`)) as unknown[];
    expect(posts).toHaveLength(0);
  });

  test("cascade only removes posts belonging to the deleted user", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.users.create(${bob})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u2")})`);
    await runner.run(`orm.users.delete("u1")`);

    const posts = (await runner.run(`orm.posts.all().toArray()`)) as { id: string }[];
    expect(posts).toHaveLength(1);
    expect(posts[0]?.id).toBe("p2");
  });

  test("deleteAll with cascade removes all users and their posts", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.users.create(${bob})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u2")})`);
    await runner.run(`orm.users.deleteAll().toArray()`);

    const users = (await runner.run(`orm.users.all().toArray()`)) as unknown[];
    expect(users).toHaveLength(0);

    const posts = (await runner.run(`orm.posts.all().toArray()`)) as unknown[];
    expect(posts).toHaveLength(0);
  });
});

test.describe("fkEnforcement / scalar FK validation", () => {
  test("creating a post with a nonexistent authorId throws a FK violation error", async ({ runner }) => {
    await runner.expectError(`orm.posts.create(${post("p1", "ghost")})`, "FK violation");
  });

  test("creating a post with a valid authorId succeeds", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    const p = (await runner.run(`orm.posts.create(${post("p1", "u1")})`)) as { id: string; authorId: string };
    expect(p.id).toBe("p1");
    expect(p.authorId).toBe("u1");
  });

  test("updating a post to a nonexistent authorId throws a FK violation error", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.expectError(`orm.posts.where({ id: "p1" }).update({ authorId: "ghost" })`, "FK violation");
  });

  test("updating a post to a valid authorId succeeds", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.users.create(${bob})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    const updated = (await runner.run(`orm.posts.where({ id: "p1" }).update({ authorId: "u2" })`)) as {
      authorId: string;
    };
    expect(updated.authorId).toBe("u2");
  });
});
