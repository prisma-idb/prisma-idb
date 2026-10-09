/**
 * Phase 6.4 — Nested relation writes: disconnect()
 *
 * The usage contract requires Post.authorId. Disconnects must reject the
 * generated null patch and leave the existing relations unchanged.
 * Covers N:1 disconnect and 1:N disconnect with all or selected children.
 */
import { expect, test } from "../helpers";

const alice = `{ id: "u1", name: "Alice", email: "alice@x.com", bio: null, score: 0, active: true, joinedAt: new Date() }`;
const post = (id: string, authorId: string) =>
  `{ id: "${id}", title: "Post ${id}", content: null, views: 0, published: false, createdAt: new Date(), authorId: "${authorId}" }`;

test.describe("nestedWrites / disconnect", () => {
  test("N:1 — disconnect rejects a required author and preserves the post", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);

    await runner.expectError(
      `
      orm.posts.where({ id: "p1" }).update({
        author: (rel) => rel.disconnect(),
      })
    `,
      /IdbRecordValidationError: Invalid update record for "Post": authorId/
    );
    const updated = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: unknown } | null;
    expect(updated!.authorId).toBe("u1");
  });

  test("1:N — disconnecting all posts rejects required authors and preserves every post", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u1")})`);

    await runner.expectError(
      `
      orm.users.where({ id: "u1" }).update({
        posts: (rel) => rel.disconnect(),
      })
    `,
      /IdbRecordValidationError: Invalid update record for "Post": authorId/
    );

    const p1 = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: unknown } | null;
    const p2 = (await runner.run(`orm.posts.findUnique("p2")`)) as { authorId: unknown } | null;
    expect(p1!.authorId).toBe("u1");
    expect(p2!.authorId).toBe("u1");
  });

  test("1:N — targeted disconnect rejects a required author and preserves both posts", async ({ runner }) => {
    await runner.run(`orm.users.create(${alice})`);
    await runner.run(`orm.posts.create(${post("p1", "u1")})`);
    await runner.run(`orm.posts.create(${post("p2", "u1")})`);

    await runner.expectError(
      `
      orm.users.where({ id: "u1" }).update({
        posts: (rel) => rel.disconnect([{ id: "p1" }]),
      })
    `,
      /IdbRecordValidationError: Invalid update record for "Post": authorId/
    );

    const p1 = (await runner.run(`orm.posts.findUnique("p1")`)) as { authorId: unknown } | null;
    const p2 = (await runner.run(`orm.posts.findUnique("p2")`)) as { authorId: unknown } | null;
    expect(p1!.authorId).toBe("u1");
    expect(p2!.authorId).toBe("u1");
  });
});
