/**
 * Phase 6.2 — createAll()
 *
 * Inserts multiple records in a single atomic batch and returns all of them.
 */
import { expect, test } from "../helpers";

test.describe("createAll()", () => {
  test("inserts all records and returns them", async ({ runner }) => {
    const rows = (await runner.run(`
      orm.users.createAll([
        { id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true,  joinedAt: new Date() },
        { id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: false, joinedAt: new Date() },
      ])
    `)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r["id"]).sort()).toEqual(["u1", "u2"]);
  });

  test("persists all records to the store", async ({ runner }) => {
    await runner.run(`
      orm.users.createAll([
        { id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() },
        { id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() },
      ])
    `);
    const all = (await runner.run(`orm.users.all()`)) as unknown[];
    expect(all).toHaveLength(2);
  });

  test("returned rows match the inserted data", async ({ runner }) => {
    const rows = (await runner.run(`
      orm.users.createAll([
        { id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 42, active: true, joinedAt: new Date() },
      ])
    `)) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ id: "u1", name: "Alice", score: 42 });
  });

  test("empty input returns empty array", async ({ runner }) => {
    const rows = await runner.run(`orm.users.createAll([])`);
    expect(rows).toEqual([]);
  });

  test("inserts 3+ records atomically", async ({ runner }) => {
    const rows = (await runner.run(`
      orm.posts.createAll([
        { id: "p1", authorId: "u1", title: "A", content: null, views: 0, published: true,  publishedAt: null },
        { id: "p2", authorId: "u1", title: "B", content: null, views: 1, published: false, publishedAt: null },
        { id: "p3", authorId: "u2", title: "C", content: null, views: 2, published: true,  publishedAt: null },
      ])
    `)) as unknown[];
    expect(rows).toHaveLength(3);
    const all = (await runner.run(`orm.posts.all()`)) as unknown[];
    expect(all).toHaveLength(3);
  });
});
