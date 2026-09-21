/**
 * Browser-side auto-migration e2e test.
 *
 * Verifies that `createAutoMigratingIdbClient` correctly upgrades a database
 * that was created under the baseline schema (users + posts + random_store,
 * no tags) to the current version (+tags) when the app loads.
 *
 * The test pre-seeds a baseline-state IDB using the raw IndexedDB API
 * (bypassing the ORM), then navigates to the app. The auto-migrating client
 * should:
 *   1. Read the marker → baseline storageHash
 *   2. Walk the contractSpace chain → find the "add_tag" migration
 *   3. Apply the DDL ops (createObjectStore + createIndex) in a version-change tx
 *   4. Update the marker → v2 storageHash
 *
 * After migration we drive the ORM through the query-runner shell to confirm
 * the new tags store is functional and existing data persists across a reload.
 */

import { expect, test } from "@playwright/test";
import { QueryRunner } from "./helpers";

// The storageHash baked into the baseline migration package (users + posts +
// random_store, no tags). This is the value the marker store holds when a DB
// was last opened against the baseline schema.
const V1_STORAGE_HASH = "122c98a5111c07549f24a259e93c2db8bcdd68bf1ee5310718c618ddd9fe8a0d";

let dbCounter = 0;
function uniqueV1DbName(workerIndex: number): string {
  return `pn-v1mig-w${workerIndex}-${++dbCounter}-${Date.now().toString(36)}`;
}

test.describe("auto-migration: incremental upgrade in the browser", () => {
  test("v1 DB (baseline, no tags) is upgraded to v2 (+tags) on first load; data survives reload", async ({
    page,
  }, testInfo) => {
    const dbName = uniqueV1DbName(testInfo.workerIndex);

    // ── Step 1: seed a baseline-state IDB before the app can touch it ────────
    // Navigate to the app root first so that `indexedDB` is available in the
    // page context. The default DB that loads here is independent of our
    // test dbName.
    await page.goto("/");

    await page.evaluate(
      async ({ dbName, markerHash }) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(dbName, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            // Baseline schema: marker + posts (with byAuthorId) +
            // random_store + users (with byEmail, byScore)
            db.createObjectStore("_prisma_next_marker", { keyPath: "space" });
            const posts = db.createObjectStore("posts", { keyPath: "id" });
            posts.createIndex("byAuthorId", "authorId", { unique: false });
            db.createObjectStore("random_store", { keyPath: "id" });
            const users = db.createObjectStore("users", { keyPath: "id" });
            users.createIndex("byEmail", "email", { unique: true });
            users.createIndex("byScore", "score");
          };
          req.onsuccess = () => {
            const db = req.result;
            // Write the baseline marker so the auto-migrating client knows
            // where this DB sits in the migration chain.
            const tx = db.transaction("_prisma_next_marker", "readwrite");
            tx.objectStore("_prisma_next_marker").put({ space: "app", storageHash: markerHash });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        });
      },
      { dbName, markerHash: V1_STORAGE_HASH }
    );

    // ── Step 2: load the app with the baseline DB ─────────────────────────────
    // The auto-migrating client reads the marker (baseline hash), walks the
    // contractSpace chain, and applies the "add_tag" migration ops before
    // handing back the typed client.
    await page.goto(`/?db=${dbName}`);
    await expect(page.getByTestId("run-query")).toBeEnabled({ timeout: 15_000 });

    const runner = new QueryRunner(page);

    // ── Step 3: verify the tags store was created by the migration ────────────
    const initialTags = (await runner.run(`orm.tags.all()`)) as unknown[];
    expect(initialTags).toHaveLength(0);

    // ── Step 4: verify baseline stores still work post-migration ─────────────
    const initialPosts = (await runner.run(`orm.posts.all()`)) as unknown[];
    expect(initialPosts).toHaveLength(0);

    const initialUsers = (await runner.run(`orm.users.all()`)) as unknown[];
    expect(initialUsers).toHaveLength(0);

    // ── Step 5: write data into the stores ───────────────────────────────────
    await runner.run(`
      orm.users.create({
        id: "u1", name: "Alice", email: "alice@test.com",
        bio: null, score: 42, active: true, joinedAt: new Date()
      })
    `);

    const createdPost = (await runner.run(`
      orm.posts.create({
        id: "p1",
        title: "Post After Migration",
        content: null,
        published: true,
        views: 0,
        authorId: "u1",
        createdAt: new Date()
      })
    `)) as { id: string; title: string };
    expect(createdPost).toMatchObject({ id: "p1", title: "Post After Migration" });

    await runner.run(`
      orm.tags.create({ id: "t1", name: "migrated", postId: "p1" })
    `);

    // ── Step 6: reload — DB is already at v2, no re-migration should occur ───
    await page.reload();
    await expect(page.getByTestId("run-query")).toBeEnabled({ timeout: 15_000 });

    const runner2 = new QueryRunner(page);

    const usersAfterReload = (await runner2.run(`orm.users.all()`)) as Array<{ id: string }>;
    expect(usersAfterReload).toHaveLength(1);
    expect(usersAfterReload[0]).toMatchObject({ id: "u1" });

    const postsAfterReload = (await runner2.run(`orm.posts.all()`)) as Array<{
      id: string;
      title: string;
    }>;
    expect(postsAfterReload).toHaveLength(1);
    expect(postsAfterReload[0]).toMatchObject({ id: "p1", title: "Post After Migration" });

    const tagsAfterReload = (await runner2.run(`orm.tags.all()`)) as Array<{ id: string }>;
    expect(tagsAfterReload).toHaveLength(1);
    expect(tagsAfterReload[0]).toMatchObject({ id: "t1" });
  });
});
