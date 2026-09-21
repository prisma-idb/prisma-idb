/**
 * Phase 6.2 — deleteCount()
 *
 * Deletes all matching rows and returns the count of deleted rows.
 */
import { expect, test } from "../helpers";

test.describe("deleteCount()", () => {
  test("returns number of deleted rows", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.deleteCount()`);
    expect(n).toBe(2);
  });

  test("returns 0 when no rows match", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where({ id: "nonexistent" }).deleteCount()`);
    expect(n).toBe(0);
  });

  test("actually removes rows even when using deleteCount", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.deleteCount()`);
    const remaining = (await runner.run(`orm.users.all()`)) as unknown[];
    expect(remaining).toHaveLength(0);
  });

  test("scopes deletion via .where()", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true,  joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: false, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where({ active: false }).deleteCount()`);
    expect(n).toBe(1);
    const remaining = (await runner.run(`orm.users.all()`)) as Record<string, unknown>[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: "u1" });
  });
});
