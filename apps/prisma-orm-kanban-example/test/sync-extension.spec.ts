import { expect, test } from "@playwright/test";
import { signInAsTestUser } from "./test-utils-signin";

/**
 * `openAndReadMarker`'s bare `factory.open(dbName)` implicitly creates a
 * fresh IDB database at version 1 before any migration runs. `autoMigrate`'s
 * combined apply (ADR 010) then does exactly ONE `upgradeneeded` bump
 * regardless of how many spaces or migration packages have pending work —
 * so a from-fresh combined apply always lands on version 2, independent of
 * the app's and the sync extension's migration-chain lengths. Not a magic
 * number to update if either chain grows.
 */
const IMPLICIT_V1_PLUS_ONE_COMBINED_BUMP = 2;

/**
 * Proves the sync extension's combined multi-space apply (ADR 011) actually
 * runs in a real browser via the real CLI-generated artifacts — not just in
 * a fake-indexeddb unit test. `db.ts` wires `extensions: [idbSyncExtension]`
 * into `createAutoMigratingIdbClient`; this asserts both the app space and
 * the `idb-sync` extension space land in the same IndexedDB database, with
 * marker rows for both, after exactly one version bump.
 */
test("sync extension stores and marker rows exist after auto-migration", async ({ page }) => {
  await signInAsTestUser(page);
  await page.goto("/");
  // Not just "Ready" — that renders as soon as the shell mounts, before the
  // session check resolves and getDb() actually opens/migrates the database.
  await expect(page.getByTestId("board-name-input")).toBeVisible({ timeout: 15_000 });

  const result = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const target = dbs.find((d) => d.name === "prisma-idb-kanban-example");
    if (!target?.name) throw new Error("kanban db not found in indexedDB.databases()");

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(target.name!);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const storeNames = Array.from(db.objectStoreNames);

    const markerTx = db.transaction("_prisma_next_marker", "readonly");
    const markerStore = markerTx.objectStore("_prisma_next_marker");
    const getMarker = (space: string) =>
      new Promise<{ space: string; storageHash: string } | undefined>((resolve, reject) => {
        const req = markerStore.get(space);
        req.onsuccess = () => resolve(req.result as { space: string; storageHash: string } | undefined);
        req.onerror = () => reject(req.error);
      });

    const [appMarker, syncMarker] = await Promise.all([getMarker("app"), getMarker("idb-sync")]);
    const version = db.version;
    db.close();

    return { storeNames, version, appMarker, syncMarker };
  });

  // App-space stores (from the kanban app's own contract) and extension
  // stores (from the sync extension) coexist in the same database.
  expect(result.storeNames).toContain("_prisma_next_marker");
  expect(result.storeNames).toContain("_idb_sync_outbox");
  expect(result.storeNames).toContain("_idb_sync_version_meta");

  // Both spaces recorded a marker row — the combined apply wrote both in one
  // batched transaction rather than the extension silently failing to apply.
  expect(result.appMarker?.space).toBe("app");
  expect(result.syncMarker?.space).toBe("idb-sync");
  expect(result.syncMarker?.storageHash).toBeTruthy();

  // One version bump covers both the app space and the extension space —
  // ADR 011's combined single-transaction apply, not one bump per space.
  expect(result.version).toBe(IMPLICIT_V1_PLUS_ONE_COMBINED_BUMP);
});
