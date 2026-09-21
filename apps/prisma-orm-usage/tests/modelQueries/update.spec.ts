/**
 * Phase 6.2 — update()
 *
 * Updates the first matching row (cursor scan, take:1). Returns the merged row
 * or null when no row matches.
 */
import { expect, test } from "../helpers";

const seed = `
  orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })
  orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })
`;

test.describe("update()", () => {
  test("updates and returns the first matching row", async ({ runner }) => {
    await runner.run(seed.trim().split("\n")[0]!.trim());
    const row = (await runner.run(`orm.users.where({ id: "u1" }).update({ name: "ALICE" })`)) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ id: "u1", name: "ALICE", email: "a@x.com" });
  });

  test("preserves fields not in the patch", async ({ runner }) => {
    await runner.run(seed.trim().split("\n")[0]!.trim());
    await runner.run(`orm.users.where({ id: "u1" }).update({ score: 99 })`);
    const row = (await runner.run(`orm.users.findUnique("u1")`)) as Record<string, unknown>;
    expect(row).toMatchObject({ id: "u1", name: "Alice", email: "a@x.com", score: 99 });
  });

  test("returns null when no row matches", async ({ runner }) => {
    const row = await runner.run(`orm.users.where({ id: "nonexistent" }).update({ name: "X" })`);
    expect(row).toBeNull();
  });

  test("persists the patch to the store", async ({ runner }) => {
    await runner.run(seed.trim().split("\n")[0]!.trim());
    await runner.run(`orm.users.where({ id: "u1" }).update({ name: "UPDATED" })`);
    const all = (await runner.run(`orm.users.all()`)) as Record<string, unknown>[];
    const alice = all.find((r) => r["id"] === "u1");
    expect(alice).toMatchObject({ name: "UPDATED" });
  });

  test("updates only the first matching row", async ({ runner }) => {
    for (const line of seed.trim().split("\n").filter(Boolean)) {
      await runner.run(line.trim());
    }
    await runner.run(`orm.users.update({ score: 999 })`);
    const all = (await runner.run(`orm.users.all()`)) as Record<string, unknown>[];
    const withNewScore = all.filter((r) => r["score"] === 999);
    expect(withNewScore).toHaveLength(1);
  });
});
