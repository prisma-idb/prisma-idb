/**
 * Phase 6.2 — count()
 *
 * Counts all rows matching the accumulated .where() filter.
 * Without a filter, counts all rows in the store.
 */
import { expect, test } from "../helpers";

test.describe("count()", () => {
  test("returns total row count when no filter", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.count()`);
    expect(n).toBe(2);
  });

  test("returns 0 for empty store", async ({ runner }) => {
    const n = await runner.run(`orm.users.count()`);
    expect(n).toBe(0);
  });

  test("returns 0 when filter matches nothing", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where({ id: "nonexistent" }).count()`);
    expect(n).toBe(0);
  });

  test("counts only filtered rows via .where() shorthand", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true,  joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: false, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where({ active: true }).count()`);
    expect(n).toBe(1);
  });

  test("counts only filtered rows via .where() callback", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u3", name: "Carol", email: "c@x.com", bio: null, score: 30, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where(u => u.score.gt(15)).count()`);
    expect(n).toBe(2);
  });

  test("count reflects store state after mutations", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    expect(await runner.run(`orm.users.count()`)).toBe(2);
    await runner.run(`orm.users.delete("u1")`);
    expect(await runner.run(`orm.users.count()`)).toBe(1);
  });
});
