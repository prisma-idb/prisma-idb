/**
 * Phase 6.6 — groupBy().aggregate()
 *
 * Partitions the matching rows by the group-key field(s), then reduces each
 * group. Each result row carries the group-key field(s) plus the aggregate
 * aliases. Run end-to-end against real Chromium IndexedDB.
 */
import { expect, test } from "../helpers";

type GroupRow = { authorId: string; count: number; totalViews: number };

function byAuthor(rows: GroupRow[]): Record<string, GroupRow> {
  return Object.fromEntries(rows.map((r) => [r.authorId, r]));
}

test.describe("groupBy().aggregate()", () => {
  test.beforeEach(async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "alice@test.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob", email: "bob@test.com", bio: null, score: 2, active: true, joinedAt: new Date() })`
    );
    // u1: 100 + 50 + 75 = 225 (p1,p3 published) | u2: 200 + 0 = 200 (p4 published)
    const posts: Array<[string, string, number, boolean]> = [
      ["p1", "u1", 100, true],
      ["p2", "u1", 50, false],
      ["p3", "u1", 75, true],
      ["p4", "u2", 200, true],
      ["p5", "u2", 0, false],
    ];
    for (const [id, authorId, views, published] of posts) {
      await runner.run(
        `orm.posts.create({ id: "${id}", authorId: "${authorId}", title: "${id}", content: null, views: ${views}, published: ${published}, publishedAt: null })`
      );
    }
  });

  test("one row per group with the key field plus aggregates", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.posts.groupBy("authorId").aggregate(agg => ({ count: agg.count(), totalViews: agg.sum("views") }))`
    )) as GroupRow[];
    expect(rows).toHaveLength(2);
    const grouped = byAuthor(rows);
    expect(grouped["u1"]).toEqual({ authorId: "u1", count: 3, totalViews: 225 });
    expect(grouped["u2"]).toEqual({ authorId: "u2", count: 2, totalViews: 200 });
  });

  test("respects a preceding where()", async ({ runner }) => {
    const rows = (await runner.run(
      `orm.posts.where({ published: true }).groupBy("authorId").aggregate(agg => ({ count: agg.count(), totalViews: agg.sum("views") }))`
    )) as GroupRow[];
    const grouped = byAuthor(rows);
    expect(grouped["u1"]).toEqual({ authorId: "u1", count: 2, totalViews: 175 }); // 100 + 75
    expect(grouped["u2"]).toEqual({ authorId: "u2", count: 1, totalViews: 200 }); // 200
  });
});
