/**
 * Phase 6.2 — updateCount()
 *
 * Updates all matching rows and returns the count (number) of updated rows.
 */
import { expect, test } from "../helpers";

test.describe("updateCount()", () => {
  test("returns total number of rows updated", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.updateCount({ active: false })`);
    expect(n).toBe(2);
  });

  test("returns 0 when no rows match", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where({ id: "nonexistent" }).updateCount({ name: "X" })`);
    expect(n).toBe(0);
  });

  test("scopes count via .where()", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true,  joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: false, joinedAt: new Date() })`
    );
    const n = await runner.run(`orm.users.where({ active: false }).updateCount({ score: 0 })`);
    expect(n).toBe(1);
  });

  test("actual updates are persisted even when using updateCount", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.updateCount({ score: 99 })`);
    const row = (await runner.run(`orm.users.findUnique("u1")`)) as Record<string, unknown>;
    expect(row).toMatchObject({ score: 99 });
  });
});
