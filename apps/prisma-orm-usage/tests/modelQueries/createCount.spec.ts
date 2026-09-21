/**
 * Phase 6.2 — createCount()
 *
 * Inserts multiple records in a single atomic batch and returns only the count.
 */
import { expect, test } from "../helpers";

test.describe("createCount()", () => {
  test("returns count of inserted records", async ({ runner }) => {
    const n = await runner.run(`
      orm.users.createCount([
        { id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() },
        { id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() },
      ])
    `);
    expect(n).toBe(2);
  });

  test("returns 0 for empty input", async ({ runner }) => {
    const n = await runner.run(`orm.users.createCount([])`);
    expect(n).toBe(0);
  });

  test("actually persists records even when using createCount", async ({ runner }) => {
    await runner.run(`
      orm.users.createCount([
        { id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() },
      ])
    `);
    const row = (await runner.run(`orm.users.findUnique("u1")`)) as Record<string, unknown>;
    expect(row).toMatchObject({ id: "u1", name: "Alice" });
  });

  test("returns exact count for 3+ records", async ({ runner }) => {
    const n = await runner.run(`
      orm.posts.createCount([
        { id: "p1", authorId: "u1", title: "A", content: null, views: 0, published: true,  publishedAt: null },
        { id: "p2", authorId: "u1", title: "B", content: null, views: 1, published: false, publishedAt: null },
        { id: "p3", authorId: "u2", title: "C", content: null, views: 2, published: true,  publishedAt: null },
      ])
    `);
    expect(n).toBe(3);
  });
});
