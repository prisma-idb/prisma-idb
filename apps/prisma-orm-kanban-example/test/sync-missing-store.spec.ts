import { expect, test } from "@playwright/test";
import type { SyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import type { Contract } from "../src/lib/prisma/contract";

type HarnessWindow = Window & {
  __syncHarness: { syncClient: SyncIdbClient<Contract>; openWithoutMigrating: () => SyncIdbClient<Contract> };
};

/**
 * Chromium's NotFoundError for a missing store doesn't name the store, so the
 * sync client has to read the database's store names to explain it. A
 * fake-indexeddb test can't show that, since its message names the store.
 */
test("a database without the outbox order store fails tracked writes with an error that names it", async ({ page }) => {
  const dbName = `sync-missing-store-${crypto.randomUUID()}`;
  await page.goto(`/test-sync-harness?db=${dbName}`);
  await expect(page.getByText("sync-harness-ready")).toBeVisible({ timeout: 15_000 });

  const result = await page.evaluate(async (dbName) => {
    const harness = (window as unknown as HarnessWindow).__syncHarness;
    await harness.syncClient.close();
    // Simulates an app that applied its own migrations but skipped the sync extension's newest one.
    await new Promise<void>((resolve, reject) => {
      const probe = indexedDB.open(dbName);
      probe.onerror = () => reject(probe.error);
      probe.onsuccess = () => {
        const version = probe.result.version;
        probe.result.close();
        const upgrade = indexedDB.open(dbName, version + 1);
        upgrade.onupgradeneeded = () => upgrade.result.deleteObjectStore("_idb_sync_outbox_order");
        upgrade.onerror = () => reject(upgrade.error);
        upgrade.onsuccess = () => {
          upgrade.result.close();
          resolve();
        };
      };
    });

    const client = harness.openWithoutMigrating();
    try {
      await client.withoutTracking((orm) =>
        orm.user.create({
          id: "u1",
          name: "Alice",
          email: "u1@example.com",
          emailVerified: false,
          image: null,
          isAnonymous: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      );
      await client.orm.board.create({ id: crypto.randomUUID(), name: "Board", userId: "u1", createdAt: new Date() });
      return null;
    } catch (error) {
      const cause = (error as Error).cause as Error | undefined;
      return { message: (error as Error).message, causeName: cause?.name, causeMessage: cause?.message };
    } finally {
      await client.close();
    }
  }, dbName);

  expect(result).not.toBeNull();
  expect(result!.message).toMatch(/no "_idb_sync_outbox_order" store[\s\S]*createAutoMigratingSyncIdbClient/);
  expect(result!.causeName).toBe("NotFoundError");
  // The browser's own message doesn't name the store, which is why the client checks the store names.
  expect(result!.causeMessage).not.toContain("_idb_sync_outbox_order");
});
